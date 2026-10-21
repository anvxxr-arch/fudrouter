package proxy_test

// Benchmarks for the router's OWN SSE relay cost — the copy loop the client
// experiences between "upstream produced a token" and "token is on the wire
// to the client".
//
// Why this file exists: the two prior measurements could not answer "what does
// the router itself add to a streaming response". One measured end-to-end TTFT
// through live paid upstreams, where the number is dominated by the model's
// generation time, not the relay. The other measured static/auth HTTP paths
// through Node's fetch, which saturated around 1850 req/s before the relay was
// ever exercised. Neither isolates the relay, and neither is reproducible
// without spending money.
//
// This file drives the relay loops directly through the export_test.go hooks
// (StreamSSEForTest / AnthropicStreamSSEForTest) against a local httptest
// upstream that emits a fixed SSE stream — no sleeps, no network beyond
// loopback, no database. The deadStoreDSN wiring from export_test.go makes
// finish()'s ledger write fail fast (~1ms), exactly as in stream_ttft_test.go,
// so the benchmark measures the relay plus one fail-fast ledger attempt per
// op — the same shape a real request pays.
//
// The upstream is a real httptest.Server, not a bytes.Reader handed straight
// to the relay: the relays read a *real* response body over a real socket, so
// the measured cost includes the bufio.Scanner chunking the network actually
// produces. Frame count and per-frame payload size are parameters of the
// stub, so both the small-token and large-token write paths are measurable.

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
)

// sseUpstreamConfig parameterizes the stub upstream's stream shape.
type sseUpstreamConfig struct {
	frames     int // number of data: frames before the [DONE] terminator
	tokenBytes int // payload size of each frame's delta.content token
}

// benchT is a zero-value *testing.T shared by every relay call. The seams
// take a *testing.T only for t.Helper() and the store.New failure path
// (relayLifecycle's t.Fatalf), neither of which fires here: deadStoreDSN
// builds without dialing, so store.New succeeds and Helper on a zero T is a
// no-op bookkeeping call. A nil T would panic in t.Helper(); a zero value
// does not.
var benchT testing.T

// The two relay seams, adapted to the shared zero-value T so the benchmark
// can drive them from inside the router handler goroutine.
func proxyStreamSSE(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader) {
	proxy.StreamSSEForTest(&benchT, w, r, body)
}

func proxyAnthropicStreamSSE(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader) {
	proxy.AnthropicStreamSSEForTest(&benchT, w, r, body)
}

// sseUpstream builds an httptest.Server that emits `frames` SSE frames, each
// carrying a token of `tokenBytes` bytes, then `data: [DONE]`. No artificial
// delay: the relay is measured, not a simulated model.
func sseUpstream(b *testing.B, cfg sseUpstreamConfig) *httptest.Server {
	b.Helper()
	token := strings.Repeat("x", cfg.tokenBytes)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, ok := w.(http.Flusher)
		if !ok {
			b.Error("upstream ResponseWriter is not an http.Flusher — the stub cannot stream")
			return
		}
		for i := 0; i < cfg.frames; i++ {
			// A token chunk is {"id":…,"choices":[…]}; no "usage" key and no
			// backslash, so the relay's fast path (skip the JSON parse) is
			// what gets measured — the path every token chunk takes.
			frame := fmt.Sprintf("data: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"%s\"}}]}\n\n", token)
			if _, err := w.Write([]byte(frame)); err != nil {
				return
			}
			f.Flush()
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		f.Flush()
	}))
	return srv
}

// relayOnce drives one full relay pass against an already-mounted router:
// one client request, one upstream fetch inside the handler, one complete
// streamed response relayed and drained. The router's httptest.Server is
// created ONCE per benchmark, outside the timed region — binding a listener
// and draining it per op would measure listener churn, not the relay.
func relayOnce(b *testing.B, routerURL string) {
	b.Helper()
	req, err := http.NewRequest(http.MethodPost, routerURL+"/v1/chat/completions", strings.NewReader("{}"))
	if err != nil {
		b.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		b.Fatalf("client request failed: %v", err)
	}
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		b.Fatalf("reading the relayed stream failed: %v", err)
	}
	resp.Body.Close()
}

// mountRouter mounts a relay on a real httptest.Server so the client reads a
// real stream over a real socket with a real Flusher. The handler fetches the
// upstream body itself, so every op pays a genuine upstream fetch plus a full
// relay pass — but no listener setup. Callers create this ONCE, before
// b.ResetTimer(), and defer Close.
func mountRouter(b *testing.B, relay func(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader), upURL string) *httptest.Server {
	b.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upReq, err := http.NewRequest(http.MethodGet, upURL, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		upResp, err := http.DefaultClient.Do(upReq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer upResp.Body.Close()
		relay(nil, w, r, upResp.Body)
	}))
}

// sseBody builds the full SSE payload once: `frames` data: frames, each
// carrying a token of `tokenBytes` bytes, then the [DONE] terminator. Used by
// the copy-loop-only benchmark, which feeds the relay an in-memory reader.
func sseBody(cfg sseUpstreamConfig) []byte {
	token := strings.Repeat("x", cfg.tokenBytes)
	var sb strings.Builder
	for range cfg.frames {
		// Same frame shape the stub upstream emits, so both benchmarks relay
		// byte-identical streams.
		fmt.Fprintf(&sb, "data: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"%s\"}}]}\n\n", token)
	}
	sb.WriteString("data: [DONE]\n\n")
	return []byte(sb.String())
}

// bytesPerOp reports the total upstream bytes one op pushes through the
// relay, so b.SetBytes() can report MB/s throughput.
func bytesPerOp(cfg sseUpstreamConfig) int64 {
	// Each frame: "data: " + JSON wrapper + token + "\n\n"; plus the [DONE] line.
	perFrame := len("data: ") + len(`{"id":"c1","choices":[{"delta":{"content":""}}]}`) + cfg.tokenBytes + 2
	done := len("data: [DONE]\n\n")
	return int64(cfg.frames*perFrame + done)
}

func BenchmarkStreamSSE_Relay(b *testing.B) {
	cfg := sseUpstreamConfig{frames: 64, tokenBytes: 32}
	up := sseUpstream(b, cfg)
	defer up.Close()
	router := mountRouter(b, proxyStreamSSE, up.URL)
	defer router.Close()
	b.SetBytes(bytesPerOp(cfg))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		relayOnce(b, router.URL)
	}
}

func BenchmarkStreamSSE_RelayLarge(b *testing.B) {
	cfg := sseUpstreamConfig{frames: 64, tokenBytes: 4096}
	up := sseUpstream(b, cfg)
	defer up.Close()
	router := mountRouter(b, proxyStreamSSE, up.URL)
	defer router.Close()
	b.SetBytes(bytesPerOp(cfg))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		relayOnce(b, router.URL)
	}
}

func BenchmarkAnthropicStreamSSE_Relay(b *testing.B) {
	cfg := sseUpstreamConfig{frames: 64, tokenBytes: 32}
	up := sseUpstream(b, cfg)
	defer up.Close()
	router := mountRouter(b, proxyAnthropicStreamSSE, up.URL)
	defer router.Close()
	b.SetBytes(bytesPerOp(cfg))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		relayOnce(b, router.URL)
	}
}

// BenchmarkStreamSSE_CopyLoopOnly is the relay-only lower bound: the same
// router mount, but the handler skips the upstream HTTP fetch and hands the
// relay an already-open bytes.Reader over the prebuilt SSE body. The gap
// between this and BenchmarkStreamSSE_Relay is the upstream-fetch overhead —
// one loopback HTTP hop — which is what isolates "relay + one client hop"
// from "the upstream fetch itself".
func BenchmarkStreamSSE_CopyLoopOnly(b *testing.B) {
	cfg := sseUpstreamConfig{frames: 64, tokenBytes: 32}
	body := sseBody(cfg)
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyStreamSSE(nil, w, r, bytes.NewReader(body))
	}))
	defer router.Close()
	b.SetBytes(bytesPerOp(cfg))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		relayOnce(b, router.URL)
	}
}
