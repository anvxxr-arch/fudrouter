package proxy_test

// The spec §8 per-phase timing map must actually be populated on a successful
// request.
//
// Why this file exists: `request_log.timing` is how a production slowdown is
// attributed to a phase instead of guessed at — it carries auth, rate_limit,
// routing, queue, connection and generation. Nothing asserted it was non-empty,
// so the column could silently be `{}` on every row and no test would notice
// (measured: every row in a test database held `{}`, which turned out to be
// because they were all failed-auth probes — the map is only filled on the
// success path, and no test had ever read a success row's timing).
//
// A timing map that is empty is worse than absent: a dashboard reading it
// reports zero everywhere rather than showing a gap.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

func TestRequestLogTimingIsPopulated(t *testing.T) {
	dsn := tests.RequireDB(t)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"c1","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	body := `{"model":"` + env.Slug + `","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var timing map[string]int64
	var latencyMs int64
	err = conn.QueryRow(ctx, `
		select timing, latency_ms from request_log
		where api_key_id = $1 order by created_at desc, id desc limit 1`, env.APIKeyID).
		Scan(&timing, &latencyMs)
	if err != nil {
		t.Fatalf("read timing: %v", err)
	}
	t.Logf("timing=%v latency_ms=%d", timing, latencyMs)

	// The phases a non-streaming call must pass through. `connection` is the
	// upstream's header time and `generation` the body time; both are set on the
	// winning exchange.
	for _, phase := range []string{"auth", "rate_limit", "routing", "connection", "generation"} {
		if _, ok := timing[phase]; !ok {
			t.Errorf("timing map is missing %q (a dashboard reading it reports zero for that phase): %v", phase, timing)
		}
	}
	// A map with keys but no values is the other failure shape: int64 zero for
	// every phase means the timers were never actually read.
	total := int64(0)
	for _, v := range timing {
		total += v
	}
	if total == 0 {
		t.Errorf("every timing value is zero — the phase timers are not being recorded: %v", timing)
	}
}
