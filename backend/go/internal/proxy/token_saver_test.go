package proxy_test

// The token-saver is only worth shipping if the saving is RECORDED. The unit
// tests in compress_test.go prove the rewrite is safe; this proves the number
// reaches request_log, which is the thing the customer sees and the reason the
// feature belongs in a metered router rather than a pass-through gateway.
//
// It is a DB-backed test on purpose: the estimate is computed in the hot path
// and written by lc.finish() through ChargeRequest, so an assertion on the
// in-memory row would pass even if the column never made it to Postgres (or if
// the insert list and the placeholder count drifted apart — the failure mode
// that adding a column to requestLogColumns invites).

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
	"github.com/jackc/pgx/v5"
)

// tokensSavedFor reads the column back for one request.
func tokensSavedFor(t *testing.T, dsn, keyID string) int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var saved int64
	if err := conn.QueryRow(ctx,
		`select tokens_saved from request_log where api_key_id = $1
		 order by created_at desc limit 1`, keyID).Scan(&saved); err != nil {
		t.Fatalf("read tokens_saved: %v", err)
	}
	return saved
}

// A request carrying a large tool result records a positive tokens_saved, and a
// request without one records zero. The second half matters: a column that
// always reports a saving would be as useless as one that never does.
func TestTokensSavedRecorded(t *testing.T) {
	dsn := tests.RequireDB(t)
	up := jsonUpstream(t, `{"ok":true}`, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	// 200 KiB of a single repeated character: no line runs to collapse, so the
	// middle-elision is what fires. That is the shape a `git diff` rerolled
	// into one long line has, and the one the compression exists for.
	big := strings.Repeat("x", 200<<10)
	send := func(content string, header map[string]string) int {
		rec := httptest.NewRecorder()
		body := `{"model":"` + env.Slug + `","stream":false,"messages":` +
			`[{"role":"user","content":"what changed?"},` +
			`{"role":"tool","tool_call_id":"call_1","content":"` + content + `"}]}`
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+env.Key)
		for k, v := range header {
			req.Header.Set(k, v)
		}
		p.ServeCompletions(rec, req)
		return rec.Code
	}

	if code := send(big, nil); code != http.StatusOK {
		t.Fatalf("compressed request: status %d, want 200", code)
	}
	if saved := tokensSavedFor(t, dsn, env.APIKeyID); saved <= 0 {
		t.Fatalf("tokens_saved = %d, want > 0 for a 200 KiB tool result", saved)
	}

	// Opt-out must be honoured end to end, not just in the unit test.
	if code := send(big, map[string]string{"X-Fudrouter-Token-Saver": "off"}); code != http.StatusOK {
		t.Fatalf("opted-out request: status %d, want 200", code)
	}
	if saved := tokensSavedFor(t, dsn, env.APIKeyID); saved != 0 {
		t.Fatalf("tokens_saved = %d with the saver disabled, want 0", saved)
	}

	// A small tool result is left alone and reports zero.
	if code := send("ok", nil); code != http.StatusOK {
		t.Fatalf("small tool result: status %d, want 200", code)
	}
	if saved := tokensSavedFor(t, dsn, env.APIKeyID); saved != 0 {
		t.Fatalf("tokens_saved = %d for a 2-byte tool result, want 0", saved)
	}
}

// The upstream must receive the SAME conversation shape, with only the tool text
// shortened. Asserted on the bytes the fake provider actually read, because that
// is the only place the claim can be checked without trusting the router's own
// bookkeeping.
func TestTokensSavedUpstreamSeesShortenedToolResult(t *testing.T) {
	dsn := tests.RequireDB(t)
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if raw, err := io.ReadAll(r.Body); err == nil {
			gotBody = string(raw)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}`))
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxy(t, dsn, up.URL)

	big := strings.Repeat("y", 120<<10)
	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":false,"messages":` +
		`[{"role":"tool","tool_call_id":"call_9","content":"` + big + `"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}

	if len(gotBody) >= len(body) {
		t.Fatalf("upstream received %d bytes for a %d-byte request; nothing was compressed",
			len(gotBody), len(body))
	}
	if !strings.Contains(gotBody, "bytes elided") {
		t.Fatal("upstream body carries no elision marker")
	}
	if !strings.Contains(gotBody, `"tool_call_id":"call_9"`) &&
		!strings.Contains(gotBody, `"tool_call_id": "call_9"`) {
		t.Fatal("tool_call_id was lost; the upstream now sees a malformed tool turn")
	}
	if !strings.Contains(gotBody, `"role":"tool"`) && !strings.Contains(gotBody, `"role": "tool"`) {
		t.Fatal("the tool role was lost")
	}
}

var _ = proxy.Handler{}
