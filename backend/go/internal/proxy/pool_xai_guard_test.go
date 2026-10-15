package proxy

// Why this test exists: the xAI token refresher was the one outbound client in
// the binary with no netguard, and its endpoint is env-overridable
// (XAI_TOKEN_ENDPOINT), so it is an admin-supplied URL in the same class as a
// provider base_url. A spoofed endpoint would receive the refresh_token grant —
// a live credential. This pins the guard so a future edit cannot quietly drop it.
//
// The first test proves the guard is actually on the wire; the second is a
// structural backstop on the client the constructor returns, so a refactor that
// rebuilds the transport without Control is caught even if it keeps the wire
// behaviour by accident. Both were verified to FAIL when the guard is removed
// (Control set to nil): the first reports "Refresh succeeded against a loopback
// endpoint", which is the credential leak this exists to prevent.

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

func TestXAIRefresherDoesNotReachLoopbackEndpoint(t *testing.T) {
	// Force the escape hatch closed rather than skipping when an operator shell
	// happens to have it open: a skipped test proves nothing, and t.Setenv
	// restores the previous value on cleanup. It must run before NewXAIRefresher,
	// which reads the flag once at construction.
	t.Setenv(netguard.AllowPrivateEnv, "")

	// The handler runs on the server's goroutine, so the flag is atomic: a plain
	// bool here is a data race, and CI runs `go test ./... -race`.
	var hit atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit.Store(true)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"leaked","refresh_token":"x","expires_in":3600}`))
	}))
	defer srv.Close()

	x := NewXAIRefresher()
	// httptest listens on 127.0.0.1, which is exactly what the guard must refuse.
	x.Endpoint = srv.URL

	_, _, _, err := x.Refresh(context.Background(), "live-refresh-token")
	if err == nil {
		t.Fatal("Refresh succeeded against a loopback endpoint; want a dial refusal")
	}
	// Name the guard, not merely "an error": a connection refused for any other
	// reason would also error, and that would not prove the guard fired.
	if !strings.Contains(err.Error(), "ssrf guard") {
		t.Fatalf("Refresh failed without naming the ssrf guard: %v", err)
	}
	if hit.Load() {
		t.Fatal("the loopback endpoint received the refresh_token grant; the dial guard did not fire")
	}
}

func TestXAIRefresherTransportCarriesTheDialGuard(t *testing.T) {
	x := NewXAIRefresher()
	if x.Client == nil {
		t.Fatal("NewXAIRefresher returned a nil client")
	}
	if x.Client.CheckRedirect == nil {
		t.Error("refresher client has no CheckRedirect; a redirect is a second unguarded request")
	}

	tr, ok := x.Client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("refresher transport is %T; the dial guard lives on an *http.Transport", x.Client.Transport)
	}
	if tr.DialContext == nil {
		t.Fatal("refresher transport has no DialContext; the guard cannot be installed")
	}

	// Prove the installed dialect is the guard and not the default: dial the
	// metadata address through it and require a refusal.
	_, err := tr.DialContext(context.Background(), "tcp", "169.254.169.254:80")
	if err == nil {
		t.Fatal("transport dialed the cloud metadata address; netguard is not installed")
	}

	// And confirm the address is one the shared rule refuses, so this test fails
	// loudly if netguard's policy ever narrows.
	if !netguard.IsBlockedIP(net.ParseIP("169.254.169.254")) {
		t.Fatal("netguard no longer blocks 169.254.169.254 — the guard changed, re-check this test")
	}
}
