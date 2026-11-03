package proxy

import "testing"

// TestPermanentQuotaFailure covers the bodies that made a drained free-tier
// account look like a momentary throttle.
//
// The live defect: freemodel.in answers an exhausted balance with HTTP 429
// ("Token balance exhausted. You have 0 tokens remaining and insufficient
// credit balance.") and the 429 branch parked the row 'rate_limited' for the
// 60s default, so the picker served it again a minute later. Measured 51
// attempts/hour returning 429 while 146 fresh credentials in the same pool
// recorded zero uses. A balance that cannot recover must take the 'invalid'
// exit (the only status the candidate filter excludes), exactly as
// classify402 already does for providers that use 402.
func TestPermanentQuotaFailure(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "freemodel 429 balance exhausted",
			body: `{"error":{"message":"Token balance exhausted. You have 0 tokens remaining and insufficient credit balance. Please top up.","type":"insufficient_quota"}}`,
			want: true,
		},
		{
			name: "empty balance phrased as credit",
			body: `{"error":{"message":"Insufficient credit balance for this request"}}`,
			want: true,
		},
		{
			name: "plan included credits gone (402 vocabulary)",
			body: `{"error":{"message":"You have used all your included credits. Top up to continue."}}`,
			want: true,
		},
		{
			name: "transient rate limit stays a throttle",
			body: `{"error":{"message":"Rate limit exceeded. Please retry after a moment.","type":"rate_limit_error"}}`,
			want: false,
		},
		{
			name: "concurrency capacity is a throttle, not a balance",
			body: `{"error":{"message":"This model is at concurrency capacity. Paid accounts are admitted first. Top up at https://freemodel.in/billing"}}`,
			want: false,
		},
		{
			name: "empty body cannot claim permanence",
			body: ``,
			want: false,
		},
		{
			name: "html gateway error is not a balance fact",
			body: `<html><head><title>502 Bad Gateway</title></head></html>`,
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := permanentQuotaFailure([]byte(tc.body)); got != tc.want {
				t.Fatalf("permanentQuotaFailure(%q) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}

// TestQuotaClassificationAgreesAcrossStatusCodes pins the invariant that made
// this a bug in the first place: the same permanent-balance fact must classify
// the same way whether the holder reports it as 402 or 429. freemodel uses 429,
// others use 402, and the router must not depend on which.
func TestQuotaClassificationAgreesAcrossStatusCodes(t *testing.T) {
	permanent := []string{
		`{"error":{"message":"Token balance exhausted. You have 0 tokens remaining and insufficient credit balance."}}`,
		`{"error":{"message":"You have used all your included credits. Top up."}}`,
	}
	for _, body := range permanent {
		if got := permanentQuotaFailure([]byte(body)); !got {
			t.Fatalf("permanentQuotaFailure(%q) = false, want true", body)
		}
		if _, ok := classify402([]byte(body)); !ok {
			t.Fatalf("classify402(%q) = not permanent; the two paths must agree", body)
		}
	}
}
