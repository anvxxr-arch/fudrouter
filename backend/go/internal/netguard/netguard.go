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
// IsBlockedIP reports whether an address is one no upstream may reach.
//
// The range list is a PORT of the shared rule in
// packages/platform/server/ssrf.ts (ipv4BlockedBig/ipv6BlockedBig) and must stay
// one: a prior audit of the console found it carrying a SHORTER blocklist than
// the shared rule, and this package then repeated the mistake against the TS
// side. Measured before this port, the Go guard ALLOWED 0.0.0.1, 0.255.255.255,
// 192.0.2.1, 192.88.99.1, 198.51.100.1, 203.0.113.1, 240.0.0.1,
// 255.255.255.255, "::127.0.0.1", "::169.254.169.254", 100::1, 2001:db8::1 and
// 2001::1 — every one of which the TS rule refuses. "::127.0.0.1" and
// "::169.254.169.254" are the damaging ones: IPv4-compatible spellings of
// loopback and of the cloud metadata address, which net.IP.To4 does NOT convert
// (only the ::ffff: mapped form), so they reached the dial unchecked.
//
// Two deliberate differences from TS, both noting that TS is the looser side:
//
//   - 2001::/32 (Teredo) IS refused here, where V6_BLOCKS in TS lists it. The
//     embedded server IPv4 is public, which is why an earlier version of this
//     file left Teredo out, but Teredo is a tunnelling mechanism end to end and
//     no legitimate provider is reached over it. Refusing it is the safe
//     direction and cannot break a real upstream.
//   - 0.0.0.0 and :: stay refused through IsUnspecified; TS's `a === 0` covers
//     the whole 0/8, and the port covers the rest of that block below.
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
		return ipv4Blocked(v4)
	}
	// IPv6: refuse the whole ::/96 comment space. net.IP.To4 converts only the
	// ::ffff: mapped form of IPv4, so an IPv4-COMPATIBLE spelling like
	// ::127.0.0.1 or ::169.254.169.254 would otherwise pass every predicate
	// above as an ordinary unrecognised v6 address.
	if len(ip) == net.IPv6len {
		hi := uint64(ip[0])<<56 | uint64(ip[1])<<48 | uint64(ip[2])<<40 | uint64(ip[3])<<32 |
			uint64(ip[4])<<24 | uint64(ip[5])<<16 | uint64(ip[6])<<8 | uint64(ip[7])
		lo := uint64(ip[8])<<56 | uint64(ip[9])<<48 | uint64(ip[10])<<40 | uint64(ip[11])<<32 |
			uint64(ip[12])<<24 | uint64(ip[13])<<16 | uint64(ip[14])<<8 | uint64(ip[15])
		if hi == 0 && lo>>32 == 0 { // ::/96 v4-compatible / unspecified / loopback
			return true
		}
		// Unwrap the transition mechanisms that carry a reachable IPv4, so the
		// IPv4 rules decide. NAT64 is 64:ff9b::/96 (prefix in bytes 1-3, IPv4 in
		// the last four); 6to4 is 2002::/16 (prefix in bytes 0-1, IPv4 at 2-5).
		if ip[1] == 0x64 && ip[2] == 0xff && ip[3] == 0x9b { // 64:ff9b::/96
			return IsBlockedIP(net.IPv4(ip[12], ip[13], ip[14], ip[15]))
		}
		if ip[0] == 0x20 && ip[1] == 0x02 { // 2002::/16
			return IsBlockedIP(net.IPv4(ip[2], ip[3], ip[4], ip[5]))
		}
	}

	// The v6 blocks TS pins in V6_BLOCKS, as prefix/bit comparisons on the raw
	// bytes so no bigint is needed.
	for _, b := range v6Blocks {
		if hasPrefix(ip, b.bytes, b.bits) {
			return true
		}
	}
	return false
}

// ipv4Blocked is ipv4BlockedBig from the shared rule, on the 4-byte form. The
// predicate helpers above already cover loopback, RFC1918, link-local (including
// 169.254.169.254), multicast and 0.0.0.0, so this covers what they do NOT.
func ipv4Blocked(v4 net.IP) bool {
	a, b, c := v4[0], v4[1], v4[2]
	switch {
	case a == 0: // 0.0.0.0/8 "this network"
		return true
	case a == 192 && b == 0 && (c == 0 || c == 2): // 192.0.0/24, TEST-NET-1
		return true
	case a == 192 && b == 88 && c == 99: // 6to4 relay anycast
		return true
	case a == 198 && b == 51 && c == 100: // TEST-NET-2
		return true
	case a == 203 && b == 0 && c == 113: // TEST-NET-3
		return true
	case a >= 224: // multicast 224/4 + reserved 240/4 + broadcast
		return true
	case a == 100 && b >= 64 && b <= 127: // 100.64.0.0/10 carrier-grade NAT
		return true
	case a == 198 && (b == 18 || b == 19): // 198.18.0.0/15 benchmarking
		return true
	}
	return false
}

// v6Block bytes/bits mirror V6_BLOCKS in the shared TS rule. 2001::/32 (Teredo)
// is included here although TS reaches it through the same table; see the
// comment on IsBlockedIP for why it is refused rather than unwrapped.
var v6Blocks = []struct {
	bytes []byte
	bits  int
}{
	{[]byte{0xfc, 0x00}, 7},              // fc00::/7 unique-local
	{[]byte{0xfe, 0x80}, 10},             // fe80::/10 link-local
	{[]byte{0xff, 0x00}, 8},              // ff00::/8 multicast
	{[]byte{0x20, 0x01, 0x0d, 0xb8}, 32}, // 2001:db8::/32 documentation
	{[]byte{0x20, 0x01}, 32},             // 2001::/32 Teredo
	{[]byte{0x01, 0x00}, 64},             // 100::/64 discard-only
}

// hasPrefix reports whether the first `bits` bits of ip match pattern. The
// pattern is the SHORT form (only the bytes needed), so the loop walks the
// pattern rather than the bit count: a 32-bit prefix is two bytes.
func hasPrefix(ip net.IP, pattern []byte, bits int) bool {
	for i := range pattern {
		if i >= len(ip) {
			return false
		}
		rem := bits - i*8
		switch {
		case rem >= 8:
			if ip[i] != pattern[i] {
				return false
			}
		case rem > 0:
			mask := byte(0xff << (8 - rem))
			if ip[i]&mask != pattern[i]&mask {
				return false
			}
		default:
			return true // every prefix bit already compared
		}
	}
	return true
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
