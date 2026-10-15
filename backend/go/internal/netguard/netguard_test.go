package netguard_test

import (
	"net"
	"net/http"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

func TestIsBlockedIP(t *testing.T) {
	cases := []struct {
		ip      string
		blocked bool
		why     string
	}{
		// Must be refused: none of these is the caller's to reach.
		{"127.0.0.1", true, "IPv4 loopback"},
		{"127.1.2.3", true, "loopback /8"},
		{"::1", true, "IPv6 loopback"},
		{"::ffff:127.0.0.1", true, "IPv4-mapped loopback"},
		{"10.0.0.1", true, "RFC1918 10/8"},
		{"172.16.0.1", true, "RFC1918 172.16/12"},
		{"192.168.1.1", true, "RFC1918 192.168/16"},
		{"169.254.169.254", true, "link-local / cloud metadata"},
		{"169.254.0.1", true, "link-local"},
		{"100.64.0.1", true, "carrier-grade NAT"},
		{"198.18.0.1", true, "benchmarking range"},
		{"0.0.0.0", true, "unspecified"},
		{"224.0.0.1", true, "multicast"},
		{"fc00::1", true, "IPv6 unique-local"},
		{"fd12:3456::1", true, "IPv6 unique-local"},
		{"fe80::1", true, "IPv6 link-local"},
		{"", true, "unparsable/empty"},
		{"::", true, "IPv6 unspecified"},
		{"::ffff:10.0.0.1", true, "IPv4-mapped RFC1918"},
		{"198.19.255.255", true, "benchmarking, last address of /15"},
		{"100.127.255.255", true, "CGNAT, last address of /10"},
		// Transition mechanisms that embed a reachable IPv4 (FIX 7): the guard
		// must unwrap and re-check them, or a base_url of [64:ff9b::7f00:1]
		// dials loopback while the guard sees an ordinary IPv6 address.
		{"64:ff9b::7f00:1", true, "NAT64 embedding IPv4 loopback 127.0.0.1"},
		{"64:ff9b::a9fe:a9fe", true, "NAT64 embedding the metadata address"},
		{"64:ff9b::0a00:1", true, "NAT64 embedding RFC1918 10.0.0.1"},
		{"64:ff9b::c0a8:1", true, "NAT64 embedding RFC1918 192.168.0.1"},
		{"2002:7f00:1::", true, "6to4 embedding IPv4 loopback 127.0.0.1"},
		{"2002:a9fe:a9fe::", true, "6to4 embedding the metadata address"},
		{"2002:0a00:1::", true, "6to4 embedding RFC1918 10.0.0.1"},
		// 0.0.0.0/8 "this network". On Linux 0.0.0.0/8 routes to the local host, so
		// 0.0.0.1 reaches the box's own listeners (Valkey, Postgres, the router
		// itself). The shared TS rule blocks the whole block; this package used to
		// allow everything except the unspecified address itself.
		{"0.0.0.1", true, "0/8 this-network, reaches local listeners on Linux"},
		{"0.255.255.255", true, "0/8 last address"},
		// The rest of the shared TS list. Each of these was ALLOWED by this package
		// until the port — measured, not assumed.
		{"192.0.0.1", true, "192.0.0/24 IETF protocol assignments"},
		{"192.0.2.1", true, "TEST-NET-1 documentation"},
		{"192.88.99.1", true, "6to4 relay anycast"},
		{"198.51.100.1", true, "TEST-NET-2 documentation"},
		{"203.0.113.1", true, "TEST-NET-3 documentation"},
		{"240.0.0.1", true, "240/4 reserved"},
		{"255.255.255.255", true, "broadcast"},
		// An IPv4-COMPATIBLE (not mapped) spelling. net.IP.To4 converts only
		// ::ffff:, so these reached the dial unchecked: ::127.0.0.1 is loopback and
		// ::169.254.169.254 is the cloud metadata address.
		{"::127.0.0.1", true, "IPv4-compatible loopback spelling"},
		{"::169.254.169.254", true, "IPv4-compatible metadata spelling"},
		{"::0.0.1.1", true, "IPv4-compatible 0.0.1.1"},
		{"100::1", true, "100::/64 discard-only"},
		{"2001:db8::1", true, "2001:db8::/32 documentation"},
		// Teredo: a tunnelling mechanism end to end, and no legitimate provider is
		// reached over it. Refusing it is the conservative direction (the shared TS
		// rule also lists it in V6_BLOCKS).
		{"2001:0:0:0:0:0:7f00:1", true, "Teredo 2001::/32"},
		{"64:ff9b::0808:0808", false, "NAT64 embedding public 8.8.8.8"},
		{"2002:0808:0808::", false, "6to4 embedding public 8.8.8.8"},
		// Must be allowed: ordinary public addresses.
		{"8.8.8.8", false, "public DNS"},
		{"1.1.1.1", false, "public DNS"},
		{"104.18.32.7", false, "public CDN"},
		{"2606:4700:4700::1111", false, "public IPv6"},
		{"20.0.0.1", false, "public Azure range, must not be caught by 2001::/32"},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if got := netguard.IsBlockedIP(ip); got != c.blocked {
			t.Errorf("IsBlockedIP(%q) = %v, want %v (%s)", c.ip, got, c.blocked, c.why)
		}
	}
}

func TestDialControlRefusesPrivateTargets(t *testing.T) {
	block := netguard.DialControl(false)
	allow := netguard.DialControl(true)
	if err := block("tcp", "127.0.0.1:9099", nil); err == nil {
		t.Error("DialControl(false) allowed 127.0.0.1:9099; want refusal")
	}
	if err := block("tcp", "169.254.169.254:80", nil); err == nil {
		t.Error("DialControl(false) allowed the metadata address; want refusal")
	}
	if err := block("tcp", "192.168.100.6:8100", nil); err == nil {
		t.Error("DialControl(false) allowed a LAN address; want refusal")
	}
	if err := block("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("DialControl(false) refused a public address: %v", err)
	}
	// The ranges the port closed. DialControl is the boundary the router actually
	// passes through, so the predicate alone is not enough: these assert the
	// refusal survives the address parsing Control does. Without this, the
	// address families that net.IP.To4 does NOT convert (the IPv4-compatible
	// ::x.y.z.w spellings) could regress silently while IsBlockedIP's own table
	// stayed green.
	for _, target := range []string{
		"0.0.0.1:6379",           // 0/8 this-network: Valkey on Linux
		"192.0.2.1:80",           // TEST-NET-1
		"240.0.0.1:80",           // 240/4 reserved
		"255.255.255.255:80",     // broadcast
		"[::127.0.0.1]:80",       // IPv4-compatible loopback spelling
		"[::169.254.169.254]:80", // IPv4-compatible metadata spelling
		"[100::1]:80",            // discard-only
		"[2001:db8::1]:443",      // documentation
		"[2001::1]:80",           // Teredo
	} {
		if err := block("tcp", target, nil); err == nil {
			t.Errorf("DialControl(false) allowed %s; want refusal", target)
		}
	}
	// A public literal must still pass, or the additions above would have made
	// the guard useless rather than safe.
	for _, target := range []string{"8.8.8.8:443", "[2606:4700:4700::1111]:443"} {
		if err := block("tcp", target, nil); err != nil {
			t.Errorf("DialControl(false) refused a public address %s: %v", target, err)
		}
	}
	// By the time Control runs, resolution has happened; a name means the guard
	// cannot vouch for the target, so it must refuse rather than resolve it.
	if err := block("tcp", "example.com:443", nil); err == nil {
		t.Error("DialControl(false) allowed an unresolved name; want refusal")
	}
	// A malformed address must be refused, not silently allowed.
	if err := block("tcp", "no-port-here", nil); err == nil {
		t.Error("DialControl(false) allowed an address without a port; want refusal")
	}
	// The escape hatch exists only for local development.
	if err := allow("tcp", "127.0.0.1:9099", nil); err != nil {
		t.Errorf("DialControl(true) refused a loopback target: %v", err)
	}
}

func TestGuardedRedirectPolicy(t *testing.T) {
	mk := func(scheme string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, scheme+"://example.com/", nil)
		return r
	}
	if err := netguard.RedirectPolicy(mk("https"), nil); err != nil {
		t.Errorf("https redirect refused: %v", err)
	}
	if err := netguard.RedirectPolicy(mk("http"), nil); err != nil {
		t.Errorf("http redirect refused: %v", err)
	}
	if err := netguard.RedirectPolicy(mk("file"), nil); err == nil {
		t.Error("file:// redirect allowed; want refusal")
	}
	via := make([]*http.Request, 5)
	if err := netguard.RedirectPolicy(mk("https"), via); err == nil {
		t.Error("redirect chain of 5 allowed; want refusal")
	}
}
