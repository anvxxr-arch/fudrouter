package limits

import (
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// A rate limit must behave like a RATE, not like a count per second window.
//
// Measured motivation: a client pacing itself at exactly 150 rps against the old
// 1-second window of 150 was refused 68 of 4,500 requests (1.5%) — the gate was
// measuring window boundaries, not load. The router had 141 requests in flight
// against a 200 budget at the time, so there was nothing to shed.
//
// The contract: a cold bucket admits ONE SECOND of traffic (burst == rate),
// refuses beyond that, then refills at the configured rate — so sustained
// traffic at the rate is served while a genuine spike is still refused.
func TestPlatformRateIsABucket(t *testing.T) {
	rps := int64(10) // burst = one second of traffic = 10 tokens
	l := New(vk.NewFake())
	lim := &store.Limits{PlatformRPS: &rps}

	for i := 0; i < int(rps); i++ {
		if _, rej := l.Check(nil, &APIKeyIdentity{KeyID: "key-a"}, lim, 0); rej != nil {
			t.Fatalf("burst request %d of %d must pass: %+v", i+1, rps, rej)
		}
	}
	if _, rej := l.Check(nil, &APIKeyIdentity{KeyID: "key-a"}, lim, 0); rej == nil {
		t.Fatal("request beyond the one-second burst must be refused")
	} else if rej.HTTPStatus != 429 || rej.Code != "RATE_LIMITED" {
		t.Fatalf("wrong rejection: %+v", rej)
	}

	// After 120ms at 10 tokens/s the bucket holds ~1.2 tokens: one request fits.
	time.Sleep(120 * time.Millisecond)
	if _, rej := l.Check(nil, &APIKeyIdentity{KeyID: "key-a"}, lim, 0); rej != nil {
		t.Fatalf("a token must refill at the configured rate: %+v", rej)
	}
}
