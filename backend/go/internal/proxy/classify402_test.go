package proxy

// The 402 body classifier.
//
// Why this exists: the router used to park every 402 for a hardcoded 900
// seconds. On prv_zro that is wrong twice over. A daily-capped free account
// answers 402 "You've used today's Free usage. It resets in 2h 11m" — a
// 15-minute bench retries it nine times before it can possibly succeed, and
// every one of those retries burns a rotation slot the rest of the pool pays
// for. A permanently drained account answers 402 "used all your included
// credits. Top up" — that never recovers, so any cooldown just re-injects a
// dead key forever.
//
// Measured 2026-11-01: five separate manual DB repairs in one evening were
// needed because the router kept stamping 30-minute/15-minute cooldowns on keys
// that were parked at a wall-clock boundary, and it re-parked a key that had
// been promoted back to healthy.

import (
	"testing"
	"time"
)

func TestClassify402DailyCapUsesResetHint(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{
			name: "hours and minutes",
			body: `{"error":{"message":"You've used today's Free usage. It resets in 2h 11m. Add a usage pack or choose a plan"}}`,
			want: 2*3600 + 11*60,
		},
		{
			name: "minutes only",
			body: `{"error":{"message":"You've used today's Free usage. It resets in 47m."}}`,
			want: 47 * 60,
		},
		{
			name: "hours only",
			body: `{"error":{"message":"You've used today's Free usage. It resets in 1h."}}`,
			want: 3600,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, permanent := classify402([]byte(tc.body))
			if permanent {
				t.Fatalf("daily cap reported as permanent")
			}
			if got != tc.want {
				t.Fatalf("got %d seconds, want %d", got, tc.want)
			}
		})
	}
}

// A daily-cap body with no parsable hint must still be parked at the wall-clock
// boundary, never at the generic 15 minutes: the cap is aligned to 00:00 UTC
// whether or not the provider spells it out.
func TestClassify402DailyCapFallsBackToUTCReset(t *testing.T) {
	body := []byte(`{"error":{"message":"You've used today's Free usage."}}`)
	got, permanent := classify402(body)
	if permanent {
		t.Fatalf("daily cap reported as permanent")
	}
	now := time.Now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	want := int(next.Sub(now).Seconds())
	// Allow a couple of seconds of drift between the two clock reads.
	if diff := got - want; diff < -5 || diff > 5 {
		t.Fatalf("got %d seconds, want about %d (until %s)", got, want, next)
	}
	// The daily cap must NOT be answered with the generic 15-minute bench.
	//
	// This assertion used to read `got <= 900` unconditionally, which is only
	// true while UTC midnight is more than 15 minutes away — so the test failed
	// every run in the last 15 minutes of a UTC day (observed at 23:59:05Z,
	// where the correct answer is 55s). The real invariant is conditional: when
	// the boundary is FURTHER than the bench, parking longer than the bench is
	// what distinguishes "park until reset" from "park 15 minutes"; when the
	// boundary is CLOSER, a shorter park is the correct answer and the equality
	// check above already covers it.
	if want > 900 && got <= 900 {
		t.Fatalf("parked for %d seconds with %d until the UTC reset — that is the generic "+
			"15-minute bench, not the wall-clock boundary", got, want)
	}
}

// "included credits" never comes back on its own: the caller must be told to
// mark the row invalid rather than bench it.
func TestClassify402IncludedCreditsIsPermanent(t *testing.T) {
	body := []byte(`{"error":{"message":"You've used all your included credits. Top up to continue."}}`)
	got, permanent := classify402(body)
	if !permanent {
		t.Fatalf("included-credits 402 was not reported permanent (got %d seconds)", got)
	}
	if got != 0 {
		t.Fatalf("permanent verdict carried a %d-second cooldown", got)
	}
}

// Anything else keeps the historical bench, so a provider whose 402 body we do
// not recognise behaves exactly as it did before this change.
func TestClassify402UnknownKeepsDefaultBench(t *testing.T) {
	body := []byte(`{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient balance"}}`)
	got, permanent := classify402(body)
	if permanent {
		t.Fatalf("unknown 402 reported as permanent")
	}
	if got != 900 {
		t.Fatalf("got %d seconds, want the 900-second default", got)
	}
}

// A sub-minute hint is a rounding artifact; the key must still get a full
// minute so the very next request does not re-pick it.
func TestClassify402SubMinuteHintIsFloored(t *testing.T) {
	body := []byte(`{"error":{"message":"You've used today's Free usage. It resets in 12s."}}`)
	got, _ := classify402(body)
	if got != 60 {
		t.Fatalf("got %d seconds, want the 60-second floor", got)
	}
}

// The two bodies below are byte-for-byte captures from zro.moonmath.ai on
// 2026-11-01, including the escaped ASCII apostrophe in "You've"/"today's".
// They exist so a provider rewording or a curly-quote substitution shows up as
// a test failure rather than as a silently-900-second bench in production.
func TestClassify402RealCapturedBodies(t *testing.T) {
	t.Run("daily cap, 1h 51m left", func(t *testing.T) {
		body := []byte(`{"error": {"message": "You've used today's Free usage. It resets in 1h 51m. Add a usage pack or choose a plan to keep going: https://zro.moonmath.ai/billing", "type": "budget_exceeded", "code": "budget_exceeded", "param": null}}`)
		got, permanent := classify402(body)
		if permanent {
			t.Fatalf("daily cap captured body reported as permanent")
		}
		if want := 3600 + 51*60; got != want {
			t.Fatalf("got %d seconds, want %d", got, want)
		}
	})
	t.Run("included credits exhausted", func(t *testing.T) {
		body := []byte(`{"error": {"message": "You've used all your included credits. Top up to keep sending requests: https://zro.moonmath.ai/billing", "type": "budget_exceeded", "code": "budget_exceeded", "param": null}}`)
		got, permanent := classify402(body)
		if !permanent {
			t.Fatalf("exhausted-plan captured body not reported permanent (got %d seconds)", got)
		}
	})
}
