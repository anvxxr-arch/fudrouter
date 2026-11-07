package proxy

// The freemodel.in maintenance envelope, at the proxy boundary.
//
// The vendor declares a SERVICE-WIDE maintenance window as HTTP 503 with a
// literal message:
//
//	{"error":"FreeModel is being upgraded right now. Please retry in a few minutes - nothing was charged."}
//
// Measured live 2026-11-03 19:17–19:37 UTC: 307 of them across 58 requests,
// every attempt classified PROVIDER_UNAVAILABLE + retryable and NOTHING parked,
// so each request spent its whole 6-attempt budget re-asking the same upgrading
// provider.
//
// This file pins the boundary the proxy owns: the envelope is recognised ONLY
// at the status it was measured at, and every other body in the same window
// keeps the classification it had (card invariant: only the measured
// freemodel envelope changes behaviour).

import (
	"net/http"
	"testing"
)

func TestMaintenanceEnvelopeStatusGate(t *testing.T) {
	live := []byte(`{"error":"FreeModel is being upgraded right now. Please retry in a few minutes - nothing was charged."}`)

	if !maintenanceEnvelope(http.StatusServiceUnavailable, live) {
		t.Fatal("the measured 503 maintenance envelope was not recognised")
	}
	// The same body at another status is not a shape this router has evidence
	// for: 429 from this provider is a per-account balance/throttle fact and must
	// keep its own handling (commit 4b429e8).
	for _, status := range []int{http.StatusOK, http.StatusTooManyRequests, http.StatusPaymentRequired, http.StatusBadGateway} {
		if maintenanceEnvelope(status, live) {
			t.Errorf("status %d: maintenance envelope recognised outside the measured 503", status)
		}
	}
	// A 503 that is NOT the freemodel envelope (nginx 502/503 pages, other
	// providers' "temporarily unavailable") must not park anything.
	negatives := [][]byte{
		[]byte(`<html><head><title>503 Service Temporarily Unavailable</title></head></html>`),
		[]byte(`{"error":"The service is temporarily unavailable, please retry"}`),
		[]byte(`{"error":"Daily limit reached. Try again tomorrow."}`),
		[]byte(`{"error":"Token balance exhausted. You have 0 tokens remaining and insufficient credit balance."}`),
		nil,
	}
	for _, body := range negatives {
		if maintenanceEnvelope(http.StatusServiceUnavailable, body) {
			t.Errorf("non-maintenance body classified as the freemodel envelope: %q", body)
		}
	}
}
