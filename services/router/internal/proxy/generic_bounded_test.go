package proxy_test

// Tests for the upstream bound on the generic /v1/* path.
//
// ServeChat has always applied nonStreamTimeout end to end. ServeGeneric did
// not: it built the upstream request with r.Context(), which only ends when the
// client disconnects. A client waiting on an upstream that never answers
// therefore held a router goroutine, its connection, and its key limits for as
// long as it liked, with nothing to cap it.
//
// The bound could not simply be copied from ServeChat, because this handler
// only learns a response is a stream from the response header, which arrives
// after the decision to send. So the phases are bounded separately: the header
// phase by the transport's ResponseHeaderTimeout, the non-streaming body by a
// timer that closes it, and a stream by nothing (the client's connection).
//
// These tests cover the property that is easy to get wrong: bounding the
// non-streaming case must not truncate a legitimate stream. The first
// implementation put a cancellable context on the upstream request and released
// it for streams — which killed resp.Body and cut every stream off after one
// event. TestGenericEventStreamIsNotTruncated is what caught that, and it is the
// reason the bound is a body-closing timer rather than a deadline.
//
// genericTimeout is reached through the export_test.go hooks so these tests can
// shorten a two-minute bound to something they can wait for.

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// The production upstream client refuses to dial loopback (see dialControl in
// guard.go) — which is the point of it, and also why every test in this file
// must opt in explicitly. A test that forgot this would see "upstream request
// failed" from the guard rather than anything to do with the bound, and could
// mistake a security rejection for a passing test.
func allowLoopback(t *testing.T) {
	t.Helper()
	t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "1")
}

// A non-streaming upstream that sends headers and then stalls forever must not
// hold the request open indefinitely. The timer closes the body, so the read
// ends and the handler returns.
func TestGenericNonStreamingBodyIsBounded(t *testing.T) {
	dsn := tests.RequireDB(t)
	allowLoopback(t)
	restore := proxy.SetGenericTimeoutForTest(500 * time.Millisecond)
	defer restore()

	release := make(chan struct{})
	defer close(release)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush() // headers are on the wire; now stall the body
		}
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(30 * time.Second): // a stuck test, not a hang in the handler
			t.Error("upstream never released and was never closed — the test outlived its own guard")
		}
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxyDefaultClient(t, dsn)

	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings",
		strings.NewReader(`{"model":"`+env.Slug+`","input":"hi"}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() { p.ServeGeneric(rec, req); close(done) }()

	select {
	case <-done:
		// Bounded. Whether it succeeded or failed is not the assertion.
	case <-time.After(20 * time.Second):
		t.Fatal("ServeGeneric still running 20s after a stalled upstream with a 500ms bound — the path is unbounded")
	}
	t.Logf("handler returned after the bound fired: status=%d body=%q", rec.Code, trunc(rec.Body.String()))
}

// The complement, and the test that catches the broken first implementation: a
// legitimate event stream must NOT be truncated. No timer is armed on that
// branch, so every event arrives.
//
// A real HTTP client is used, not httptest.ResponseRecorder: the recorder
// implements no http.Flusher, so streamSSE's flush is a no-op and every event
// lands in one buffer — which reads exactly like a truncated stream and would
// fail this for a reason that has nothing to do with the bound.
func TestGenericEventStreamIsNotTruncated(t *testing.T) {
	dsn := tests.RequireDB(t)
	allowLoopback(t)
	// A bound far shorter than the stream, so a timer wrongly armed for the
	// streaming branch would visibly truncate it.
	const streamBound = 400 * time.Millisecond
	restore := proxy.SetGenericTimeoutForTest(streamBound)
	defer restore()

	const events = 12
	const gap = 120 * time.Millisecond
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, _ := w.(http.Flusher)
		for i := 0; i < events; i++ {
			fmt.Fprintf(w, "data: {\"i\":%d}\n\n", i)
			if f != nil {
				f.Flush()
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(gap):
			}
		}
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxyDefaultClient(t, dsn)

	// Mount the handler on a real server so the client reads a real stream.
	router := httptest.NewServer(http.HandlerFunc(p.ServeGeneric))
	defer router.Close()

	req, err := http.NewRequest(http.MethodPost, router.URL+"/v1/embeddings",
		strings.NewReader(`{"model":"`+env.Slug+`","input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+env.Key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("client request failed: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "event-stream") {
		t.Fatalf("content-type = %q, want an event stream", ct)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the stream failed: %v", err)
	}
	got := strings.Count(string(body), `"i":`)
	t.Logf("stream relayed %d of %d events over %v, with a %v bound that applies only to non-streaming bodies",
		got, events, time.Duration(events)*gap, streamBound)

	if got == 0 {
		t.Fatalf("no events relayed at all; body=%q", trunc(string(body)))
	}
	if got != events {
		t.Errorf("relayed %d of %d events — the stream was truncated, so a bound is still closing a streaming body", got, events)
	}
}

// A normal, non-streaming response must still complete normally. The timer must
// not fire on a fast body and must not corrupt a good answer.
func TestGenericNormalResponseIsUnaffected(t *testing.T) {
	dsn := tests.RequireDB(t)
	allowLoopback(t)
	restore := proxy.SetGenericTimeoutForTest(5 * time.Second)
	defer restore()

	const payload = `{"object":"list","data":[{"embedding":[0.1,0.2]}],"usage":{"prompt_tokens":7,"total_tokens":7}}`
	up := jsonUpstream(t, payload, nil, 200)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxyDefaultClient(t, dsn)

	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings",
		strings.NewReader(`{"model":"`+env.Slug+`","input":"hello"}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	rec := httptest.NewRecorder()
	p.ServeGeneric(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "embedding") {
		t.Errorf("body was corrupted: %q", trunc(rec.Body.String()))
	}
	if got := tests.LastRequestLog(t, dsn, env.APIKeyID).TokensIn; got != 7 {
		t.Errorf("billed tokens in = %d, want 7", got)
	}
}

func trunc(s string) string {
	if len(s) > 160 {
		return s[:160] + "..."
	}
	return s
}
