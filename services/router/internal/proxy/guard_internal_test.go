package proxy

import (
	"net"
	"net/http"
	"testing"
)

// The guard's predicates are unexported, so this is an internal test. Go allows
// `package proxy` and `package proxy_test` files side by side in one directory.

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

		// Must be allowed: ordinary public addresses.
		{"8.8.8.8", false, "public DNS"},
		{"1.1.1.1", false, "public DNS"},
		{"104.18.32.7", false, "public CDN"},
		{"2606:4700:4700::1111", false, "public IPv6"},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if got := isBlockedIP(ip); got != c.blocked {
			t.Errorf("isBlockedIP(%q) = %v, want %v (%s)", c.ip, got, c.blocked, c.why)
		}
	}
}

func TestDialControlRefusesPrivateTargets(t *testing.T) {
	block := dialControl(false)
	allow := dialControl(true)

	if err := block("tcp", "127.0.0.1:9099", nil); err == nil {
		t.Error("dialControl(false) allowed 127.0.0.1:9099; want refusal")
	}
	if err := block("tcp", "169.254.169.254:80", nil); err == nil {
		t.Error("dialControl(false) allowed the metadata address; want refusal")
	}
	if err := block("tcp", "192.168.100.6:8100", nil); err == nil {
		t.Error("dialControl(false) allowed a LAN address; want refusal")
	}
	if err := block("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("dialControl(false) refused a public address: %v", err)
	}
	// By the time Control runs, resolution has happened; a name means the guard
	// cannot vouch for the target, so it must refuse rather than resolve it.
	if err := block("tcp", "example.com:443", nil); err == nil {
		t.Error("dialControl(false) allowed an unresolved name; want refusal")
	}
	// The escape hatch exists only for local development.
	if err := allow("tcp", "127.0.0.1:9099", nil); err != nil {
		t.Errorf("dialControl(true) refused a loopback target: %v", err)
	}
}

func TestGuardedRedirectPolicy(t *testing.T) {
	mk := func(scheme string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, scheme+"://example.com/", nil)
		return r
	}

	if err := guardedRedirectPolicy(mk("https"), nil); err != nil {
		t.Errorf("https redirect refused: %v", err)
	}
	if err := guardedRedirectPolicy(mk("file"), nil); err == nil {
		t.Error("file:// redirect allowed; want refusal")
	}
	via := make([]*http.Request, 5)
	if err := guardedRedirectPolicy(mk("https"), via); err == nil {
		t.Error("redirect chain of 5 allowed; want refusal")
	}
}
