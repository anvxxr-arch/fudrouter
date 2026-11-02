package proxy

import (
	"net/http"
	"testing"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// The wire status a taxonomy code surfaces as is a contract, not a detail: a
// caller's retry policy keys off it. An upstream 503 (horde "no online worker",
// google "high demand") must reach the client as 503, not as a 502 that reads
// as "the gateway is broken". ProviderUnavailable/UpstreamError used to share
// the 502 that ClassifyUpstream gave both 502 and 503 upstream statuses.
func TestErrTableWireStatus(t *testing.T) {
	cases := []struct {
		code string
		want int
	}{
		{routing.ErrCodeRateLimited, http.StatusTooManyRequests},
		{routing.ErrCodeInsufficientCredits, http.StatusPaymentRequired},
		{routing.ErrCodeModelNotFound, http.StatusNotFound},
		{routing.ErrCodeProviderTimeout, http.StatusGatewayTimeout},
		{routing.ErrCodeProviderUnavailable, http.StatusServiceUnavailable},
		{routing.ErrCodeCircuitOpen, http.StatusServiceUnavailable},
		{routing.ErrCodeUpstreamError, http.StatusBadGateway},
	}
	for _, tc := range cases {
		if got := statusCodeFor(tc.code); got != tc.want {
			t.Errorf("statusCodeFor(%q) = %d, want %d", tc.code, got, tc.want)
		}
	}
}

// An unknown code must fall back to the internal-error row, never to a zero
// status (which http.ResponseWriter would treat as 200).
func TestStatusCodeForUnknownCode(t *testing.T) {
	if got := statusCodeFor("NOT_A_TAXONOMY_CODE"); got != http.StatusInternalServerError {
		t.Errorf("statusCodeFor(unknown) = %d, want %d", got, http.StatusInternalServerError)
	}
}
