package freebuff

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

// The freebuff client must carry the same SSRF dial guard as the [OI] client.
//
// This is the asymmetry the shared netguard package closed: newClient used to
// build a bare http.Client, so a provider whose credential blob declared
// protocol="freebuff" could drive the router into the internal network —
// 169.254.169.254 for the instance's credentials, or a scan of the loopback
// interface — and, with redirects followed by default, a public upstream could
// 302 onto either. guard.go's own rationale names this exact threat.
//
// The escape hatch is cleared here: the test asserts the guard is wired, so
// ALLOW_PRIVATE_UPSTREAMS must not be inherited from the environment.
func TestClientRefusesNonPublicUpstream(t *testing.T) {
	t.Setenv(netguard.AllowPrivateEnv, "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("REACHED"))
	}))
	defer srv.Close()

	m := New(srv.URL)
	_, err := m.Chat(t.Context(), srv.URL, "tok", "model", []byte(`{"messages":[]}`))
	if err == nil {
		t.Fatal("freebuff reached a loopback upstream: its client has no SSRF dial guard")
	}
}

// The escape hatch must still work for a deployment that runs local upstreams —
// it is the documented dev path, and a guard that fails closed there breaks it.
func TestClientAllowsPrivateUpstreamWhenExplicitlyEnabled(t *testing.T) {
	t.Setenv(netguard.AllowPrivateEnv, "1")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"active","instanceId":"i-1","model":"model"}`))
	}))
	defer srv.Close()

	m := New(srv.URL)
	_, err := m.Chat(t.Context(), srv.URL, "tok", "model", []byte(`{"messages":[]}`))
	// The stub answers only step one, so a later failure is expected. What must
	// NOT happen is a dial refusal.
	if err != nil && strings.Contains(err.Error(), "ssrf guard") {
		t.Errorf("guard refused a loopback upstream with the escape hatch on: %v", err)
	}
}
