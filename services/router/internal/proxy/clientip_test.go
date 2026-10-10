package proxy

import (
	"net/http/httptest"
	"testing"
)

// clientIP walks X-Forwarded-For right-to-left skipping trusted proxies.
// No key, no DB, no Valkey: pure function under test. trustedProxies is a
// startup-parsed global, so each case saves and restores it.
func TestClientIPSkipsTrustedProxies(t *testing.T) {
	old := trustedProxies
	defer func() { trustedProxies = old }()

	cases := []struct {
		name    string
		trusted string
		xff     string
		remote  string
		want    string
	}{
		{"no env trusts nothing, XFF forged is ignored", "", "1.2.3.4", "127.0.0.1:1", "127.0.0.1"},
		{"direct caller forging XFF gets peer, never the forgery", "127.0.0.1", "203.0.113.9", "198.51.100.7:1234", "198.51.100.7"},
		{"loopback trusted, real client survives", "127.0.0.1", "203.0.113.9, 127.0.0.1", "127.0.0.1:1", "203.0.113.9"},
		{"all hops trusted falls back to RemoteAddr", "127.0.0.1", "127.0.0.1", "127.0.0.1:1", "127.0.0.1"},
		{"no XFF uses RemoteAddr", "127.0.0.1", "", "10.9.8.7:1234", "10.9.8.7"},
		{"CIDR trusted", "10.0.0.0/8", "203.0.113.9, 10.1.2.3", "10.9.9.9:1", "203.0.113.9"},
		{"IPv6 client through loopback", "127.0.0.1", "2404:c0:b203::1, 127.0.0.1", "127.0.0.1:1", "2404:c0:b203::1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trustedProxies = parseTrustedProxies(tc.trusted)
			r := httptest.NewRequest("GET", "http://x/", nil)
			r.RemoteAddr = tc.remote
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clientIP(r); got != tc.want {
				t.Errorf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIPAllowed(t *testing.T) {
	if !ipAllowed([]string{"203.0.113.9"}, "203.0.113.9") {
		t.Error("exact match must allow")
	}
	if ipAllowed([]string{"203.0.113.9"}, "198.51.100.7") {
		t.Error("different IP must deny")
	}
	if !ipAllowed([]string{"10.0.0.0/8"}, "10.9.8.7") {
		t.Error("CIDR member must allow")
	}
	if ipAllowed([]string{"10.0.0.0/8"}, "11.0.0.1") {
		t.Error("CIDR outsider must deny")
	}
	if ipAllowed([]string{"203.0.113.9"}, "") {
		t.Error("empty IP must deny")
	}
}
