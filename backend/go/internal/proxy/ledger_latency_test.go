package proxy_test

// The ledger retry loop must not hold the client's connection.
//
// Why this test exists: finish() retries a failed ledger write three times with
// 250ms/500ms backoff (lifecycle.go ledgerWriteAttempts/ledgerWriteBackoff). The
// comment justifying that loop says "the goroutine is already past the client's
// response, so the only cost of the extra attempts is a held goroutine" — but
// every call site is `defer lc.finish()` or an inline `lc.finish()` on the
// REQUEST goroutine (proxy.go:366, stream.go:127, anthropic.go:121, gemini.go:242,
// generic.go:166). A deferred call runs before the handler returns, so the
// connection is not released until the sleeps finish.
//
// Measured before the fix: BenchmarkStreamSSE_CopyLoopOnly = 754,214,153 ns/op,
// which is exactly 250ms + 500ms of sleeps plus three refused dials to
// deadStoreDSN (~4ms). The benchmark's own comment claimed the write "fails fast
// (~1ms)" — off by 750x.
//
// This test pins the client-visible property, not the implementation: a request
// whose ledger write fails must still return promptly. It fails on the old code
// (754ms) and passes once the retry is detached.

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestLedgerRetryDoesNotBlockClient measures wall-clock time from "client sent
// the request" to "client finished reading the response" against a store whose
// ledger write always fails. The relay itself is microseconds; anything above
// the threshold is the retry loop leaking onto the request goroutine.
func TestLedgerRetryDoesNotBlockClient(t *testing.T) {
	cfg := sseUpstreamConfig{frames: 8, tokenBytes: 32}
	body := sseBody(cfg)

	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyStreamSSE(nil, w, r, bytes.NewReader(body))
	}))
	defer router.Close()

	// Warm one request so listener setup and the first dial are not counted.
	doRelay(t, router.URL)

	const budget = 50 * time.Millisecond
	start := time.Now()
	doRelay(t, router.URL)
	elapsed := time.Since(start)

	if elapsed > budget {
		t.Fatalf("client waited %v for a response whose ledger write failed; "+
			"want < %v. The retry loop is sleeping on the request goroutine "+
			"(ledgerWriteAttempts x ledgerWriteBackoff = 750ms).", elapsed, budget)
	}
}

func doRelay(t *testing.T, url string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url+"/v1/chat/completions", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("client request failed: %v", err)
	}
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatalf("reading the relayed stream failed: %v", err)
	}
	resp.Body.Close()
}
