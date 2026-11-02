package proxy

import (
	"bytes"
	"io"
	"log"
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
