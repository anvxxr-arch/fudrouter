package egress_test

// Opt-in public echo probes distinguish locally bound socket tests from real
// routed IPv6 egress. No inference credential is used. A missing opt-in skips
// rather than turning the ordinary suite into a dependency on an echo service.

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
)

func TestEgressLiveIPv6Affinity(t *testing.T) {
	target := os.Getenv("EGRESS_LIVE_ECHO_URL")
	if target == "" {
		t.Skip("EGRESS_LIVE_ECHO_URL not set; operator pool and public egress are not ordinary unit-test dependencies")
	}
	t.Setenv("SOURCE_ROTATE", "1")
	t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "0")
	m := egress.New(nil)
	t.Cleanup(func() { egress.CloseForTest(m) })
	probe := func(policy egress.Policy) (net.IP, *egress.Route) {
		t.Helper()
		route, err := m.Prepare(policy, "live-probe-not-a-provider-secret")
		if err != nil || route == nil {
			t.Fatalf("live egress prepare: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := route.Client.Do(req)
		if err != nil {
			t.Fatalf("live echo: %v", err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 256))
		ip := net.ParseIP(strings.TrimSpace(string(body)))
		if err != nil || resp.StatusCode != 200 || ip == nil || ip.To4() != nil || !ip.IsGlobalUnicast() {
			t.Fatalf("live IPv6 echo status=%d body=%q err=%v", resp.StatusCode, body, err)
		}
		return ip, route
	}
	policy := egress.Policy{Mode: egress.StickyOwn, StickyTTLSeconds: 3600}
	first, route := probe(policy)
	second, _ := probe(policy)
	if !first.Equal(second) {
		t.Fatalf("public echo changed for one credential: %s -> %s", first, second)
	}
	route.Reject(second, http.StatusTooManyRequests)
	next, _ := probe(policy)
	if first.Equal(next) {
		t.Fatalf("public echo reused burned source %s", first)
	}
	direct, _ := probe(egress.Policy{Mode: egress.Direct})
	directAgain, _ := probe(egress.Policy{Mode: egress.Direct})
	if !direct.Equal(directAgain) {
		t.Fatalf("direct public echo changed: %s -> %s", direct, directAgain)
	}
	t.Logf("live public echo: sticky %s twice; burn -> %s; direct %s twice", first, next, direct)
}
