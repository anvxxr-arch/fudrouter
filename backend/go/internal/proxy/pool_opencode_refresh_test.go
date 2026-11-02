package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

// A connection that declares its own oauth_endpoint/oauth_client_id must get a
// refresher pointed at THAT endpoint (not the xAI default). prove it by
// building a target through the same config path applyConnectionConfig uses.
func TestConnectionConfigSelectsOAuthRefresher(t *testing.T) {
	cred := credentials{AuthKind: "oauth"}
	applyConnectionConfig(&cred, []byte(`{
		"protocol": "openai",
		"auth_kind": "oauth",
		"oauth_endpoint": "https://console.opencode.ai/auth/device/token",
		"oauth_client_id": "opencode-cli"
	}`))
	if cred.OAuthEndpoint != "https://console.opencode.ai/auth/device/token" {
		t.Fatalf("OAuthEndpoint not parsed: %q", cred.OAuthEndpoint)
	}
	if cred.OAuthClientID != "opencode-cli" {
		t.Fatalf("OAuthClientID not parsed: %q", cred.OAuthClientID)
	}

	// newPool must swap in an OAuthRefresher bound to the connection endpoint.
	cred.Accounts = []account{{Email: "a@b.c", AccessToken: "tok", RefreshToken: "rf", Expired: "2099-01-01T00:00:00Z"}}
	p := newPool(cred, NewXAIRefresher(), func(s string) (string, error) { return s, nil },
		nil, nil)
	r, ok := p.refresher.(*OAuthRefresher)
	if !ok {
		t.Fatalf("refresher not OAuthRefresher: %T", p.refresher)
	}
	if r.Endpoint != "https://console.opencode.ai/auth/device/token" {
		t.Fatalf("refresher endpoint = %q, want opencode", r.Endpoint)
	}
	if r.ClientID != "opencode-cli" {
		t.Fatalf("refresher client_id = %q, want opencode-cli", r.ClientID)
	}
}

// Without oauth_endpoint, newPool keeps the handler default (xAI).
func TestNoEndpointKeepsDefaultRefresher(t *testing.T) {
	cred := credentials{AuthKind: "oauth", Protocol: "openai"}
	cred.Accounts = []account{{Email: "a@b.c", AccessToken: "tok", RefreshToken: "rf", Expired: "2099-01-01T00:00:00Z"}}
	dflt := NewXAIRefresher()
	p := newPool(cred, dflt, func(s string) (string, error) { return s, nil }, nil, nil)
	if p.refresher != dflt {
		t.Fatalf("default refresher was replaced without an endpoint")
	}
}

// The opencode token endpoint accepts form + JSON bodies; the OAuthRefresher's
// Refresh() must send grant_type=refresh_token form-encoded and read the
// rotated access_token/refresh_token/expires_in from the JSON response.
func TestOAuthRefresherRefreshGrantWireFormat(t *testing.T) {
	t.Setenv(netguard.AllowPrivateEnv, "true")
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		gotBody = r.PostForm.Encode()
		if r.PostForm.Get("grant_type") != "refresh_token" {
			t.Errorf("grant_type = %q", r.PostForm.Get("grant_type"))
		}
		if r.PostForm.Get("refresh_token") != "rf-secret" {
			t.Errorf("refresh_token not forwarded")
		}
		if r.PostForm.Get("client_id") != "opencode-cli" {
			t.Errorf("client_id not forwarded")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-at","refresh_token":"new-rf","expires_in":21600}`))
	}))
	defer srv.Close()

	r := NewOAuthRefresher(srv.URL, "opencode-cli")
	at, next, exp, err := r.Refresh(t.Context(), "rf-secret")
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if at != "new-at" || next != "new-rf" || exp != 21600 {
		t.Fatalf("got at=%q next=%q exp=%d", at, next, exp)
	}
	if !strings.Contains(gotBody, "grant_type=refresh_token") {
		t.Fatalf("body not form-encoded refresh grant: %s", gotBody)
	}
	_ = json.Marshal // keep import honest if assertions are trimmed
}
