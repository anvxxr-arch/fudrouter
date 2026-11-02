package proxy_test

// A map-only sticky test misses the important wiring: SQL -> cached candidate
// -> picked credential row -> per-source transport -> actual bound socket. This
// uses the host's assigned global /128s and the isolated DB, but a LOCAL upstream
// so running the suite never sends catalogue credentials to real providers.

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/egress"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/sourceip"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

func setEgress(t *testing.T, dsn string, env *tests.Env, mode string, anonymous bool) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	config := `{"auth_kind":"bearer"}`
	if anonymous {
		config = `{"auth_kind":"noauth"}`
	}
	if _, err := conn.Exec(ctx, `update connection set egress_mode=$2, sticky_ttl_seconds=3600, config=$3::jsonb where id=$1`, env.ConnectionID, mode, config); err != nil {
		t.Fatal(err)
	}
}

func servePolicyRequest(t *testing.T, p *proxy.Handler, env *tests.Env) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"`+env.Slug+`","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	p.ServeCompletions(rec, req)
	return rec
}

func completion(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"id":"egress-test","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
}

func TestEgressPolicyStickyOwnIPv6(t *testing.T) {
	dsn := tests.RequireDB(t)
	t.Setenv("SOURCE_ROTATE", "1")
	address := sourceip.Pick()
	if address == nil || sourceip.Count() < 2 {
		t.Skip("host has no two assigned global IPv6 sources; deterministic socket tests still cover affinity")
	}
	ln, err := net.Listen("tcp6", "[::]:0")
	if err != nil {
		t.Skipf("IPv6 listener unavailable: %v", err)
	}
	var mu sync.Mutex
	var sources []string
	var rejectNext int
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Force a real dial per request: otherwise 100 keep-alive hits could
		// look sticky even if the next socket would choose a different /128.
		w.Header().Set("Connection", "close")
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		mu.Lock()
		sources = append(sources, ip)
		status := rejectNext
		rejectNext = 0
		mu.Unlock()
		if r.Header.Get("Authorization") != "" {
			t.Error("anonymous credential leaked its placeholder upstream")
		}
		if status != 0 {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"message":"IP rejected"}}`)
			return
		}
		completion(w)
	}))
	_ = up.Listener.Close()
	up.Listener = ln
	up.Start()
	t.Cleanup(up.Close)
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	target := "http://" + net.JoinHostPort(address.String(), port)
	env := tests.SeedEnv(t, dsn, target)
	setEgress(t, dsn, env, egress.StickyOwn, true)
	p := tests.NewProxy(t, dsn, target)
	// The imported account ceiling is 75 rpm (the initial 100-request fixture
	// was rejected on request 76). Two CALLER accounts avoid disabling that
	// production rule; both still resolve the same provider credential row.
	second := tests.SeedEnv(t, dsn, target)
	second.Slug = env.Slug
	requestCounts := make(map[string]int)
	send := func(caller *tests.Env) *httptest.ResponseRecorder {
		t.Helper()
		requestCounts[caller.UserID]++
		return servePolicyRequest(t, p, caller)
	}
	for i := 0; i < 100; i++ {
		caller := env
		if i%2 == 1 {
			caller = second
		}
		if rec := send(caller); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status=%d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	mu.Lock()
	seen := make(map[string]bool)
	for _, ip := range sources {
		seen[ip] = true
	}
	first := sources[0]
	mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("100 real IPv6 proxy requests used %d sources, want 1", len(seen))
	}
	t.Logf("headline: 100 DB-backed IPv6 proxy requests on fresh sockets, %d distinct source IP", len(seen))
	for _, status := range []int{http.StatusTooManyRequests, http.StatusPaymentRequired, http.StatusForbidden} {
		mu.Lock()
		rejectNext = status
		mu.Unlock()
		rec := send(env)
		if status != http.StatusForbidden && rec.Code != http.StatusOK {
			t.Fatalf("status %d rotation did not recover: router status=%d body=%s", status, rec.Code, rec.Body.String())
		}
		// A ban is terminal for this exchange, but the following request must
		// still bind a replacement rather than preserve the banned affinity.
		if rec := send(env); rec.Code != http.StatusOK {
			t.Fatalf("request after %d: %d %s", status, rec.Code, rec.Body.String())
		}
		mu.Lock()
		last := sources[len(sources)-1]
		mu.Unlock()
		if first == last || sourceip.Usable(net.ParseIP(first)) {
			t.Fatalf("status %d did not burn/rotate %s -> %s", status, first, last)
		}
		t.Logf("HTTP %d burn rotated %s -> %s", status, first, last)
		first = last
	}
	// Wait for request_log writes before helper cleanup closes its store. The
	// fixture must not get its measurement by bypassing the real ledger path.
	for userID, count := range requestCounts {
		waitForPolicyLogs(t, dsn, userID, count)
	}
}

func TestEgressPolicyAuthenticatedStickyOwnIPv6(t *testing.T) {
	dsn := tests.RequireDB(t)
	t.Setenv("SOURCE_ROTATE", "1")
	address := sourceip.Pick()
	if address == nil || sourceip.Count() < 2 {
		t.Skip("host has no two assigned IPv6 sources")
	}
	ln, err := net.Listen("tcp6", net.JoinHostPort(address.String(), "0"))
	if err != nil {
		t.Skipf("IPv6 listener unavailable: %v", err)
	}
	var mu sync.Mutex
	var sources []net.IP
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+tests.UpstreamKeyPlain {
			t.Error("provider credential lost on sticky HTTP dispatch")
		}
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		mu.Lock()
		sources = append(sources, net.ParseIP(ip))
		mu.Unlock()
		w.Header().Set("Connection", "close")
		completion(w)
	}))
	_ = up.Listener.Close()
	up.Listener = ln
	up.Start()
	t.Cleanup(up.Close)
	env := tests.SeedEnv(t, dsn, up.URL)
	setEgress(t, dsn, env, egress.StickyOwn, false)
	p := tests.NewProxy(t, dsn, up.URL)
	// Two caller accounts retain the measured 75-rpm admission rule while
	// exercising ONE bearer credential across 100 actual TCP dials.
	second := tests.SeedEnv(t, dsn, up.URL)
	second.Slug = env.Slug
	requestCounts := make(map[string]int)
	send := func(caller *tests.Env) *httptest.ResponseRecorder {
		t.Helper()
		requestCounts[caller.UserID]++
		return servePolicyRequest(t, p, caller)
	}
	for i := 0; i < 100; i++ {
		caller := env
		if i%2 == 1 {
			caller = second
		}
		if rec := send(caller); rec.Code != 200 {
			t.Fatalf("credentialed sticky request: %d %s", rec.Code, rec.Body.String())
		}
	}
	mu.Lock()
	first := sources[0]
	seen := make(map[string]bool)
	for _, ip := range sources {
		seen[ip.String()] = true
	}
	count, distinct := len(sources), len(seen)
	mu.Unlock()
	if count != 100 || distinct != 1 {
		t.Fatalf("100 bearer-credential requests used %d sockets and %d sources", count, distinct)
	}
	t.Logf("headline: %d DB-backed bearer-credential requests on fresh sockets, %d distinct source IP", count, distinct)
	sourceip.Burn(first, time.Minute)
	if rec := send(env); rec.Code != 200 {
		t.Fatalf("credentialed request after burn: %d %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	if first.Equal(sources[len(sources)-1]) {
		t.Error("bearer credential reused its burned source")
	}
	mu.Unlock()
	for userID, count := range requestCounts {
		waitForPolicyLogs(t, dsn, userID, count)
	}
}

func waitForPolicyLogs(t *testing.T, dsn, userID string, want int) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for {
		var count int
		if err := conn.QueryRow(ctx, `select count(*) from request_log where user_id=$1`, userID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d policy request logs settled", count, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEgressPolicyDirectAndInertPool(t *testing.T) {
	dsn := tests.RequireDB(t)
	for _, mode := range []string{egress.Direct, egress.Pool, egress.IPv6Rotate} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "1")
			t.Setenv(egress.DirectIPEnv, "127.0.0.2")
			t.Setenv(egress.PoolEnabledEnv, "0")
			t.Setenv(egress.PoolURLEnv, "http://127.0.0.1:3128")
			t.Setenv(egress.PoolKeyEnv, "")
			var mu sync.Mutex
			var sources []string
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ip, _, _ := net.SplitHostPort(r.RemoteAddr)
				mu.Lock()
				sources = append(sources, ip)
				mu.Unlock()
				if r.Header.Get("Authorization") != "Bearer "+tests.UpstreamKeyPlain {
					t.Error("provider credential did not survive policy dispatch")
				}
				completion(w)
			}))
			t.Cleanup(up.Close)
			env := tests.SeedEnv(t, dsn, up.URL)
			setEgress(t, dsn, env, mode, false)
			p := tests.NewProxy(t, dsn, up.URL)
			for i := 0; i < 2; i++ {
				rec := servePolicyRequest(t, p, env)
				if rec.Code != http.StatusOK {
					t.Fatalf("mode %s: status=%d body=%s", mode, rec.Code, rec.Body.String())
				}
				var body map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
			}
			want := "127.0.0.1"
			if mode == egress.Direct {
				want = "127.0.0.2"
			}
			mu.Lock()
			if len(sources) != 2 || sources[0] != want || sources[1] != want {
				t.Errorf("mode %s: sources=%v, want two %s sockets", mode, sources, want)
			}
			mu.Unlock()
			waitForPolicyLogs(t, dsn, env.UserID, 2)
		})
	}
}
