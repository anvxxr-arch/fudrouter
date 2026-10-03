package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The router serves two inbound wire protocols, so a key can arrive in either
// carrier. Getting this wrong makes one surface unusable for its own clients.
func TestBearerOrAPIKey(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		want    string
		wantErr bool
	}{
		{
			name:    "[OI] client: Authorization Bearer",
			headers: map[string]string{"Authorization": "Bearer sk-ar-abc_def"},
			want:    "sk-ar-abc_def",
		},
		{
			name:    "Anthropic client: x-api-key",
			headers: map[string]string{"x-api-key": "sk-ar-abc_def"},
			want:    "sk-ar-abc_def",
		},
		{
			name: "Authorization wins when both are present",
			headers: map[string]string{
				"Authorization": "Bearer sk-ar-from-auth",
				"x-api-key":     "sk-ar-from-header",
			},
			want: "sk-ar-from-auth",
		},
		{
			name:    "no credential at all",
			headers: nil,
			wantErr: true,
		},
		{
			name:    "Authorization present but not Bearer",
			headers: map[string]string{"Authorization": "Basic dXNlcjpwYXNz"},
			wantErr: true,
		},
		{
			name:    "blank x-api-key is not a credential",
			headers: map[string]string{"x-api-key": ""},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
			for k, v := range tc.headers {
				r.Header.Set(k, v)
			}
			got, err := bearerOrAPIKey(r)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want an error, got key %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
