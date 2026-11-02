package egress_test

// The ~3-concurrent-request anonymous ceiling does not justify a credential
// changing source /128 every request. These use real bound TCP sockets, not
// merely equality of a cached Pick: shared keep-alive transports can otherwise
// preserve the wrong credential's source even when the affinity map is correct.

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

type testSources struct {
	mu     sync.Mutex
	ips    []net.IP
	next   int
	burned map[string]bool
}

func (s *testSources) pick() net.IP {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < len(s.ips); i++ {
		ip := s.ips[s.next%len(s.ips)]
		s.next++
		if !s.burned[ip.String()] {
			return ip
		}
	}
	return nil
}

func (s *testSources) usable(ip net.IP) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ip != nil && !s.burned[ip.String()]
}

func (s *testSources) burn(ip net.IP, _ time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ip != nil {
		s.burned[ip.String()] = true
	}
}

func socketFixture(t *testing.T) (*egress.Manager, *httptest.Server, *testSources) {
	t.Helper()
	t.Setenv(netguard.AllowPrivateEnv, "1")
	t.Setenv(egress.DirectIPEnv, "")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		_, _ = io.WriteString(w, host)
	}))
	t.Cleanup(up.Close)
	sources := &testSources{
		ips:    []net.IP{net.ParseIP("127.0.0.2"), net.ParseIP("127.0.0.3")},
		burned: make(map[string]bool),
	}
	m := egress.NewWithSourcesForTest(&http.Client{}, sources.pick, sources.usable, sources.burn,
		func() net.IP { return sources.ips[0] })
	t.Cleanup(func() { egress.CloseForTest(m) })
	return m, up, sources
}

func send(t *testing.T, m *egress.Manager, policy egress.Policy, credential, target string) (string, net.IP, *egress.Route, bool) {
	t.Helper()
	route, err := m.Prepare(policy, credential)
	if err != nil || route == nil {
		t.Fatalf("Prepare: route=%v err=%v", route, err)
	}
	var actual net.IP
	var reused bool
	ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			host, _, _ := net.SplitHostPort(info.Conn.LocalAddr().String())
			actual, reused = net.ParseIP(host), info.Reused
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-provider-token")
	resp, err := route.Client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("response: status=%d body=%s err=%v", resp.StatusCode, body, err)
	}
	return string(body), actual, route, reused
}

func TestEgressSameCredentialBindsSameAddress(t *testing.T) {
	m, up, _ := socketFixture(t)
	policy := egress.Policy{Mode: egress.StickyOwn, StickyTTLSeconds: 3600}
	seen := make(map[string]bool)
	var first *http.Client
	for i := 0; i < 100; i++ {
		ip, actual, route, reused := send(t, m, policy, "cred-a", up.URL)
		seen[ip] = true
		if ip != "127.0.0.2" || actual.String() != ip {
			t.Fatalf("request %d: peer=%s local=%s, want 127.0.0.2", i, ip, actual)
		}
		if i == 0 {
			first = route.Client
		} else if route.Client != first || !reused {
			t.Fatal("same credential did not retain its transport/keep-alive socket")
		}
	}
	if len(seen) != 1 {
		t.Fatalf("100 credential requests used %d source addresses, want 1", len(seen))
	}
	t.Logf("headline: 100 real TCP requests, %d distinct source IP, 99 keep-alive reuses", len(seen))
	other, _, second, _ := send(t, m, policy, "cred-b", up.URL)
	if other == "127.0.0.2" || second.Client == first {
		t.Fatal("another credential inherited the first credential's bound socket")
	}
	// Returning to A after B catches a single context-keyed transport: its
	// idle queue can otherwise hand A the connection that B just returned.
	again, _, _, _ := send(t, m, policy, "cred-a", up.URL)
	if again != "127.0.0.2" {
		t.Fatalf("credential A after B bound %s", again)
	}
}

func TestEgressBurnRotatesNextRequest(t *testing.T) {
	for _, status := range []int{402, 429, 403} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			m, up, sources := socketFixture(t)
			policy := egress.Policy{Mode: egress.StickyOwn}
			first, actual, route, _ := send(t, m, policy, "cred-burn", up.URL)
			route.Reject(actual, status)
			next, _, _, reused := send(t, m, policy, "cred-burn", up.URL)
			if first == next || reused || !sources.burned[first] {
				t.Fatalf("status %d: first=%s next=%s reused=%v burned=%v", status, first, next, reused, sources.burned)
			}
		})
	}
}

func TestEgressDirectIsStableEvenAfterRejection(t *testing.T) {
	m, up, sources := socketFixture(t)
	policy := egress.Policy{Mode: egress.Direct}
	first, actual, route, _ := send(t, m, policy, "cred-a", up.URL)
	route.Reject(actual, http.StatusTooManyRequests)
	next, _, second, _ := send(t, m, policy, "cred-b", up.URL)
	if first != next || first != "127.0.0.2" || second.Client != route.Client || len(sources.burned) != 0 {
		t.Fatalf("direct identity changed: %s -> %s, burned=%v", first, next, sources.burned)
	}
}

func TestEgressPoolIsInertUnlessConfigured(t *testing.T) {
	cases := []struct{ name, gate, endpoint, consumer string }{
		{"all absent", "", "", ""},
		{"gate absent", "", "http://127.0.0.1:3128", "test-consumer"},
		{"gate false", "0", "http://127.0.0.1:3128", "test-consumer"},
		{"consumer absent", "1", "http://127.0.0.1:3128", ""},
		{"endpoint absent", "1", "", "test-consumer"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(egress.PoolEnabledEnv, tc.gate)
			t.Setenv(egress.PoolURLEnv, tc.endpoint)
			t.Setenv(egress.PoolKeyEnv, tc.consumer)
			m := egress.New(nil)
			// No parse, no remote username, no pool dial while dormant. An invalid
			// DB URL must not override the operator's disabled gate.
			route, err := m.Prepare(egress.Policy{Mode: egress.Pool, ProxyURL: "not-a-url"}, "")
			if err != nil || route != nil || egress.ClientCountForTest(m) != 0 {
				t.Fatalf("inert pool allocated a route/client: route=%v err=%v", route, err)
			}
		})
	}
}

func TestEgressSSRFGuardSurvivesBoundAndFallbackDials(t *testing.T) {
	t.Setenv(netguard.AllowPrivateEnv, "0")
	// An incompatible source family errors before Control runs, so the bound
	// case needs IPv4; the IPv6 case specifically exercises guarded fallback.
	for _, tc := range []struct {
		ip       string
		fallback bool
	}{{"127.0.0.2", false}, {"2001:db8::1", true}} {
		conn, err := egress.DialSource(context.Background(), "tcp", "127.0.0.1:1", net.ParseIP(tc.ip), tc.fallback)
		if conn != nil {
			conn.Close()
			t.Fatal("dialed a private target")
		}
		if err == nil || !strings.Contains(err.Error(), "ssrf guard") {
			t.Fatalf("fallback=%v: guard was bypassed: %v", tc.fallback, err)
		}
	}
}

func TestEgressExplicitBindingDoesNotFallBack(t *testing.T) {
	m, up, _ := socketFixture(t)
	t.Setenv(egress.DirectIPEnv, "2001:db8::dead")
	route, err := m.Prepare(egress.Policy{Mode: egress.Direct}, "")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := route.Client.Get(up.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("unassignable direct source silently fell back to the kernel source")
	}
}

func TestEgressInvalidPolicy(t *testing.T) {
	m := egress.New(nil)
	if _, err := m.Prepare(egress.Policy{Mode: "typo"}, "cred-a"); err == nil {
		t.Fatal("unknown mode accepted")
	}
	if _, err := m.Prepare(egress.Policy{Mode: egress.StickyOwn}, ""); err == nil {
		t.Fatal("missing credential ID shared one global sticky identity")
	}
	if route, err := m.Prepare(egress.Policy{}, "cred-a"); err != nil || route != nil {
		t.Fatal("old cached candidates lost historical default behaviour")
	}
}
