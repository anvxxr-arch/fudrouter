package proxy_test

// The SSE relays must not buffer: the first event has to reach the client while
// the upstream is still producing, not after it finishes.
//
// Why this file exists: AGENTS.md:304-305 states the rule — "SSE must not be
// buffered — anything that buffers breaks TTFT and the `ttft_ms` column" — and
// nothing in the suite asserted it. The two existing streaming tests both read
// the stream to COMPLETION before looking at anything (stream_test.go's
// TestStreamNotCutByClientTimeout, generic_bounded_test.go's
// TestGenericEventStreamIsNotTruncated), so a relay that accumulated the whole
// upstream body and wrote it at the end would pass both: every chunk still
// arrives, in order, with [DONE]. The only observable difference is WHEN the
// first byte lands, and that is exactly what those tests never look at.
//
// The bug this prevents is silent and total. `ttft_ms` is measured from
// streamStart to the first relayed line (stream.go:49-51), so a buffering relay
// records the upstream's TOTAL generation time as TTFT — a 30s answer reports
// ttft_ms=30000 instead of ~200. Every dashboard percentile over that column is
// then wrong, and the client sees no tokens until the answer is already
// complete, which is the one thing a streaming API exists to avoid. A
// regression here ships green and degrades every streaming request.
//
// The assertion is ORDERING, never latency: the client must observe the first
// event BEFORE the upstream signals completion. The upstream blocks on a
// channel the test only closes at the very end, so "before completion" is a
// happens-before relation, not a stopwatch. The generous timeouts (seconds) are
// there so a loaded box cannot make this flake — a slow machine delays both
// sides equally and the ordering still holds.
//
// Two relays carry the identical risk and both are gated here, because the
// flush-per-line shape is duplicated rather than shared: streamSSE
// (stream.go:23) for the [OI] chat path and anthropicStreamSSE
// (anthropic.go:518) for the Anthropic surface. A buffering regression in
// either one is the same defect, and a gate that covered only the first would
// leave the second shipping green.
//
// The router is a real httptest.Server, not a ResponseRecorder: the recorder
// implements no http.Flusher, so the relays' flush is a no-op and every event
// lands in one buffer (generic_bounded_test.go:100-103 records this trap). A
// recorder would make the test pass for a reason that has nothing to do with
// the relay.
//
// The relays are driven directly through the export_test.go hooks rather than
// through ServeCompletions, because admission (auth, limits, budget, model
// resolution) needs a seeded database and the property under test lives
// entirely inside the relay loop. What this gate does NOT cover is the wiring
// that chooses the streaming branch — that is ServeCompletions' `if stream`
// (proxy.go:313-316) and generic.go:165-168, which the DB-backed tests already
// exercise end to end.
//
// Verified by mutation: reading the whole upstream body before the first write
// turns both subtests red.

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/proxy"
)

// firstEventTimeout bounds how long the client waits for the response headers
// and then for the first event. It is seconds, not milliseconds, and
// deliberately far larger than any plausible relay delay: the assertion is that
// the event arrives while the upstream is still blocked, so a slow box must not
// be able to fail it.
const firstEventTimeout = 10 * time.Second

// upstreamBlockTimeout bounds how long the test waits for the upstream to
// finish after it is released. Same reasoning: it is a stuck-test guard, not a
// performance bound.
const upstreamBlockTimeout = 20 * time.Second

// blockingUpstream is an SSE upstream that sends its headers and first event,
// then holds the connection open without sending anything more until release is
// closed. It closes released when its handler returns, so the test can prove
// the client saw the first event BEFORE that happened.
//
// The block is a channel, never a sleep: a sleep would make the test's claim
// about ordering depend on two clocks agreeing, while a channel makes it a
// happens-before relation the test can observe directly.
func blockingUpstream(t *testing.T, release <-chan struct{}) (srv *httptest.Server, released <-chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, ok := w.(http.Flusher)
		if !ok {
			t.Error("upstream ResponseWriter is not an http.Flusher — the fake cannot stream")
			return
		}
		// The first event, flushed, so it is on the wire before the block.
		if _, err := w.Write([]byte("data: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")); err != nil {
			return
		}
		f.Flush()
		// Hold the connection open. The client must have the first event by now.
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(upstreamBlockTimeout):
			t.Error("upstream was never released and its request never ended — the test outlived its own guard")
		}
		// The terminator, so a relay that DOES stream sees a well-formed end.
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		f.Flush()
	}))
	t.Cleanup(srv.Close)
	return srv, done
}

// doWithTimeout issues req and fails the test if the response HEADERS do not
// arrive within firstEventTimeout.
//
// The timeout is applied here rather than on the http.Client because
// http.Client.Timeout bounds the whole exchange INCLUDING the body, and this
// test deliberately holds the upstream open past the point the headers are due
// (stream_test.go:14-18 records that trap). A client-side timeout would fire
// during the blocked phase and fail a relay that is streaming correctly.
func doWithTimeout(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	type result struct {
		resp *http.Response
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		ch <- result{resp, err}
	}()
	select {
	case res := <-ch:
		if res.err != nil {
			t.Fatalf("client request failed: %v", res.err)
		}
		return res.resp
	case <-time.After(firstEventTimeout):
		t.Fatalf("no response headers within %v while the upstream was still blocked — the relay buffered the stream", firstEventTimeout)
		return nil
	}
}

// readUntil reads lines from r until one contains want, and returns it. It
// fails the test if nothing matching arrives within firstEventTimeout.
//
// This exists because the Anthropic relay emits `message_start` BEFORE it reads
// a single upstream byte (anthropic.go:541-552), so "the client got an event"
// is not by itself evidence of streaming there — a buffering relay still emits
// message_start immediately. The event that proves the relay is forwarding as
// it reads is the first one derived from upstream DATA, which is what this
// waits for.
func readUntil(t *testing.T, r *bufio.Reader, want string) string {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				ch <- result{line, err}
				return
			}
			if strings.Contains(line, want) {
				ch <- result{line, nil}
				return
			}
		}
	}()
	select {
	case res := <-ch:
		if res.err != nil {
			t.Fatalf("stream ended before an event carrying %q arrived: %v", want, res.err)
		}
		return res.line
	case <-time.After(firstEventTimeout):
		t.Fatalf("no event carrying %q reached the client within %v while the upstream was still blocked — the relay is buffering the stream", want, firstEventTimeout)
		return ""
	}
}

// TestSSEFirstEventArrivesBeforeUpstreamCompletes is the gate: the first event
// must be observable by the client while the upstream is still holding the
// connection open.
//
// Table-driven over both relays because the flush-per-line shape is duplicated
// rather than shared, so a buffering regression lands in one of them and the
// other must still be pinned.
func TestSSEFirstEventArrivesBeforeUpstreamCompletes(t *testing.T) {
	relays := []struct {
		name string
		// relay drives one relay loop against the upstream body, writing to w.
		relay func(t *testing.T, w http.ResponseWriter, r *http.Request, body io.Reader)
		// wantFirst is the substring the first DATA-DERIVED event must carry.
		// It is deliberately not the first event on the wire: the Anthropic
		// relay emits message_start before reading any upstream byte, so
		// waiting for that would pass against a buffering relay. Waiting for
		// the first event that could only exist because an upstream line was
		// read is what makes the assertion mean something.
		wantFirst string
		// wantTail is the substring the stream must end with. It differs per
		// relay because the Anthropic surface TRANSLATES the terminator into
		// message_stop rather than forwarding the [OI] `[DONE]` line.
		wantTail string
	}{
		{
			name:      "chat completions relay",
			relay:     proxy.StreamSSEForTest,
			wantFirst: `"content":"first"`,
			wantTail:  "[DONE]",
		},
		{
			name:      "anthropic messages relay",
			relay:     proxy.AnthropicStreamSSEForTest,
			wantFirst: `"text":"first"`,
			wantTail:  "message_stop",
		},
	}

	for _, tc := range relays {
		t.Run(tc.name, func(t *testing.T) {
			release := make(chan struct{})
			up, released := blockingUpstream(t, release)

			// The upstream body the relay reads: a real response body from a
			// real server, so the relay sees exactly what production sees.
			upReq, err := http.NewRequest(http.MethodGet, up.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			upResp, err := http.DefaultClient.Do(upReq)
			if err != nil {
				t.Fatalf("upstream request failed: %v", err)
			}
			defer upResp.Body.Close()

			// The relay under test, mounted on a real server so the client
			// reads a real stream over a real socket with a real Flusher.
			router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tc.relay(t, w, r, upResp.Body)
			}))
			defer router.Close()

			req, err := http.NewRequest(http.MethodPost, router.URL+"/v1/chat/completions", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			resp := doWithTimeout(t, req)
			defer resp.Body.Close()
			if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "event-stream") {
				t.Fatalf("content-type = %q, want an event stream", ct)
			}

			// The ordering assertion. The upstream is blocked here and cannot
			// have completed, so anything the client reads is proof the relay
			// forwarded it as it arrived. readUntil fails the test itself if
			// nothing data-derived arrives, so there is no second check to make.
			readUntil(t, bufio.NewReader(resp.Body), tc.wantFirst)

			// The complement, and the half that makes the assertion two-sided:
			// the upstream must NOT have finished. If it had, "the client got
			// an event" would prove nothing about buffering.
			select {
			case <-released:
				t.Fatal("the upstream completed before the client saw the first event — the relay buffered the stream")
			default:
			}

			// Release and confirm the stream still terminates cleanly, so a
			// relay that streams cannot pass by truncating.
			close(release)
			select {
			case <-released:
			case <-time.After(upstreamBlockTimeout):
				t.Fatal("upstream never completed after release")
			}
			tail, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("reading the stream tail failed: %v", err)
			}
			if !strings.Contains(string(tail), tc.wantTail) {
				t.Errorf("stream tail = %q, want the %q terminator", string(tail), tc.wantTail)
			}
		})
	}
}
