// Package netguard is the data plane's SSRF boundary, shared by every
// outbound upstream client.
//
// The control plane validates a provider's base_url when an admin saves it, but
// that check is (a) literal-only and (b) not a security boundary: the spec says
// so explicitly — "The control plane is not a security boundary" (S0 §280), so
// the Go data plane re-enforces independently. The upstream client used to dial
// whatever base_url the database held, and because it followed redirects by
// default, a hostile or compromised upstream could 302 the router onto an
// internal address the write-time literal check never saw.
//
// The guard is a dial-time Control hook, not a URL pre-check. That distinction
// matters: Control receives the address AFTER DNS resolution, so a name that
// resolves to a private IP (DNS rebinding) is caught, and because every
// redirect opens a new connection through the same transport, redirects are
// covered for free — no separate CheckRedirect policy to keep in sync.
//
// This package exists because the boundary was implemented twice with
// different strength: the [OI] client was guarded and the freebuff client was
// not, so a provider whose credential blob declared protocol="freebuff" could
// drive the router into the internal network. One package, one rule, every
// upstream client.
package netguard

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
)

// AllowPrivateEnv mirrors the control plane's ALLOW_PRIVATE_UPSTREAMS escape
// hatch so a single setting means the same thing on both planes. It is needed
// only for local development against a loopback upstream; it must never be set
// on a host that serves untrusted base_urls. Default: off (fail closed).
const AllowPrivateEnv = "ALLOW_PRIVATE_UPSTREAMS"

// AllowPrivate reads the escape hatch from the environment. Only explicit
// truthy values open it, so a typo or an empty string fails closed.
func AllowPrivate() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(AllowPrivateEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// IsBlockedIP reports whether ip is outside the public internet and therefore
// must not be dialed as an upstream.
//
// Beyond net.IP's own predicates (loopback, private RFC1918/ULA, link-local,
// multicast, unspecified) this covers carrier-grade NAT and the benchmarking
// range, both of which reach hosts that are not the caller's to reach. The AWS
// instance-metadata address 169.254.169.254 is already link-local.
//
// Two IPv6 transition mechanisms embed a full IPv4 address that the router
// would actually reach, so they are unwrapped and re-checked as IPv4:
// NAT64 (64:ff9b::/96, the IPv4 at bytes 12-15) and 6to4 (2002::/16, the IPv4
// at bytes 2-5). Without this, a provider base_url of
// `http://[64:ff9b::7f00:1]/` dials loopback and the guard never notices.
// Teredo (2001::/32) is deliberately NOT unwrapped: its embedded client IPv4
// sits at a different offset and its server IPv4 is public, so unwrapping it
// would block legitimate addresses.
func IsBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsPrivate() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 100 && v4[1]&0xc0 == 64 { // 100.64.0.0/10 carrier-grade NAT
			return true
		}
		if v4[0] == 198 && (v4[1] == 18 || v4[1] == 19) { // 198.18.0.0/15 benchmarking
			return true
		}
		return false
	}
	// IPv6: unwrap the transition mechanisms that carry a reachable IPv4.
	// NAT64 is 64:ff9b::/96, so the prefix occupies bytes 1-3 and the embedded
	// IPv4 is the last four bytes. 6to4 is 2002::/16, so the prefix occupies
	// bytes 0-1 and the embedded IPv4 follows at bytes 2-5.
	if len(ip) == net.IPv6len {
		if ip[1] == 0x64 && ip[2] == 0xff && ip[3] == 0x9b { // 64:ff9b::/96 NAT64
			return IsBlockedIP(net.IPv4(ip[12], ip[13], ip[14], ip[15]))
		}
		if ip[0] == 0x20 && ip[1] == 0x02 { // 2002::/16 6to4
			return IsBlockedIP(net.IPv4(ip[2], ip[3], ip[4], ip[5]))
		}
	}
	return false
}

// DialControl returns a net.Dialer.Control hook that refuses non-public dial
// targets. Control runs after name resolution and before the socket connects,
// so a rejected target never receives a byte.
//
// A non-IP address is refused rather than resolved here: by the time Control
// runs, resolution has already happened, so a name at this point means the
// resolver was bypassed and the guard cannot vouch for the target.
func DialControl(allowPrivate bool) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, _ syscall.RawConn) error {
		if allowPrivate {
			return nil
		}
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("ssrf guard: unparsable dial address %q", address)
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("ssrf guard: refusing unresolved dial target %q", address)
		}
		if IsBlockedIP(ip) {
			return fmt.Errorf("ssrf guard: refusing to dial non-public address %s", ip)
		}
		return nil
	}
}

// RedirectPolicy caps redirect hops and rejects a hop that leaves http(s). The
// dial guard already blocks redirects onto private addresses, so this only
// bounds the chain and the scheme.
func RedirectPolicy(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return fmt.Errorf("ssrf guard: stopped after %d redirects", len(via))
	}
	if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
		return fmt.Errorf("ssrf guard: refusing redirect to scheme %q", req.URL.Scheme)
	}
	return nil
}
