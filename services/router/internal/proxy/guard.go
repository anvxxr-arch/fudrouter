package proxy

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
)

// This file is the data plane's SSRF guard.
//
// The control plane validates a provider's base_url when an admin saves it, but
// that check is (a) literal-only and (b) not a security boundary: the spec says
// so explicitly — "The control plane is not a security boundary" (S0 §280), and
// the Go data plane must re-enforce independently. Until now it did not: the
// upstream client dialed whatever base_url the database held, and because the
// client followed redirects by default, a hostile or compromised upstream could
// 302 the router onto an internal address that the write-time literal check
// never saw.
//
// The guard is a dial-time Control hook, not a URL pre-check. That distinction
// matters: Control receives the address AFTER DNS resolution, so a name that
// resolves to a private IP (DNS rebinding) is caught, and because every
// redirect opens a new connection through the same transport, redirects are
// covered for free — no separate CheckRedirect policy to keep in sync.

// allowPrivateUpstreams mirrors the control plane's ALLOW_PRIVATE_UPSTREAMS
// escape hatch so a single setting means the same thing on both planes. It is
// needed only for local development against a loopback upstream; it must never
// be set on a host that serves untrusted base_urls. Default: off (fail closed).
func allowPrivateUpstreams() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ALLOW_PRIVATE_UPSTREAMS"))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// isBlockedIP reports whether ip is outside the public internet and therefore
// must not be dialed as an upstream.
//
// Beyond net.IP's own predicates (loopback, private RFC1918/ULA, link-local,
// multicast, unspecified) this covers carrier-grade NAT and the benchmarking
// range, both of which reach hosts that are not the caller's to reach. The AWS
// instance-metadata address 169.254.169.254 is already link-local.
func isBlockedIP(ip net.IP) bool {
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
	}
	return false
}

// dialControl returns a net.Dialer.Control hook that refuses non-public dial
// targets. Control runs after name resolution and before the socket connects,
// so a rejected target never receives a byte.
//
// A non-IP address is refused rather than resolved here: by the time Control
// runs, resolution has already happened, so a name at this point means the
// resolver was bypassed and the guard cannot vouch for the target.
func dialControl(allowPrivate bool) func(network, address string, c syscall.RawConn) error {
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
		if isBlockedIP(ip) {
			return fmt.Errorf("ssrf guard: refusing to dial non-public address %s", ip)
		}
		return nil
	}
}

// guardedRedirectPolicy caps redirect hops and rejects a hop that leaves
// http(s). The dial guard already blocks redirects onto private addresses, so
// this only bounds the chain and the scheme.
func guardedRedirectPolicy(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return fmt.Errorf("ssrf guard: stopped after %d redirects", len(via))
	}
	if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
		return fmt.Errorf("ssrf guard: refusing redirect to scheme %q", req.URL.Scheme)
	}
	return nil
}
