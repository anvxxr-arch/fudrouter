package proxy_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/tests"
)

// The production client used to be `&http.Client{Timeout: 120 * time.Second}`,
// and http.Client.Timeout bounds the WHOLE exchange including the response body —
// so any streaming completion longer than two minutes was severed mid-answer.
// This uses the real production client (via NewProxyDefaultClient) and a stream
// that dribbles for ~3s: every chunk and the [DONE] terminator must arrive.
func TestStreamNotCutByClientTimeout(t *testing.T) {
	// The production client refuses non-public dial targets (SSRF guard). This
	// test deliberately serves the upstream from a loopback httptest server, so
	// it must opt in the same way a developer running locally would.
	t.Setenv("ALLOW_PRIVATE_UPSTREAMS", "1")

	dsn := tests.RequireDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for i := 0; i < 10; i++ {
			fmt.Fprintf(w, "data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"chunk%d \"}}]}\n\n", i)
			fl.Flush()
			time.Sleep(300 * time.Millisecond)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	p := tests.NewProxyDefaultClient(t, dsn)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	out := rec.Body.String()
	if n := strings.Count(out, "chunk"); n != 10 {
		t.Fatalf("received %d/10 chunks — the stream was cut by the client timeout", n)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Error("terminator [DONE] never reached the client")
	}
}
