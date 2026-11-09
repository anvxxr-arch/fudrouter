package proxy

import (
	"bufio"
	"bytes"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// F7 (HA hardening): a handler panic used to propagate to net/http's
// per-connection recover, which closed the connection and — because the
// lifecycle's finish() never ran — dropped the request_log row entirely, making
// the request invisible to billing and ledger reconciliation. The middleware
// catches the panic and maps it to the taxonomy 500; if the handler already
// committed a status, it must NOT write a second header.
//
// The x-fudrouter-request-id header is set by lifecycle.begin, which runs
// before any real panic, so it is outside this middleware's scope; the test
// pins the two things the middleware itself owns.
func TestRecoverMiddleware(t *testing.T) {
	p := &Handler{}
	newServer := func(next http.Handler) (*httptest.Server, *bytes.Buffer) {
		var logBuf bytes.Buffer
		srv := httptest.NewUnstartedServer(RecoverMiddleware(p, next))
		srv.Config.ErrorLog = log.New(&logBuf, "", 0)
		srv.Start()
		t.Cleanup(srv.Close)
		return srv, &logBuf
	}

	t.Run("panic before write yields taxonomy 500", func(t *testing.T) {
		srv, _ := newServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("boom")
		}))
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("status %d, want 500", resp.StatusCode)
		}
		if !strings.Contains(string(body), `"code":"INTERNAL_ERROR"`) {
			t.Fatalf("body %q, want INTERNAL_ERROR envelope", body)
		}
	})

	t.Run("panic after 200 keeps committed status, no second header", func(t *testing.T) {
		srv, logBuf := newServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("partial"))
			panic("boom")
		}))
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d, want committed 200", resp.StatusCode)
		}
		if string(body) != "partial" {
			t.Fatalf("body %q, want truncated 'partial'", body)
		}
		if strings.Contains(logBuf.String(), "superfluous") {
			t.Errorf("second WriteHeader attempted after a committed status: %q", logBuf.String())
		}
	})
}

// TestRecoverMiddlewarePreservesFlusher pins the P0 streaming regression: the
// middleware wraps the whole mux in production, and `wroteHeader` embedded
// http.ResponseWriter WITHOUT a Flush method, so every stream relay's
// `w.(http.Flusher)` type-assert failed and all SSE responses were buffered.
// A Flush on the wrapped writer must reach the underlying Flusher.
func TestRecoverMiddlewarePreservesFlusher(t *testing.T) {
	p := &Handler{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("wrapped writer does not satisfy http.Flusher; streaming would be buffered")
			return
		}
		w.WriteHeader(http.StatusOK)
		f.Flush()
	})
	srv := httptest.NewUnstartedServer(RecoverMiddleware(p, next))
	srv.Config.ConnState = nil
	srv.Start()
	t.Cleanup(srv.Close)

	// A raw client so we can observe the flush on the wire (a flushed empty
	// chunk arrives before the body completes).
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatalf("write request: %v", err)
	}
	br := bufio.NewReader(conn)
	var statusSeen bool
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			break
		}
		if strings.HasPrefix(line, "HTTP/1.1 200") {
			statusSeen = true
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}
	if !statusSeen {
		t.Fatalf("no 200 status seen; the Flush did not produce a status line")
	}
}
