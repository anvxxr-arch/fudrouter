package proxy

import (
	"testing"
	"time"
)

// TestQuota5hStartAnchoredToMidnight pins the 5h quota block boundaries to UTC
// midnight (00:00, 05:00, 10:00, 15:00, 20:00). The old now.Truncate(5h) was
// epoch-anchored, so blocks drifted 4h per day (24 mod 5 = 4) — a "5h" window
// reset at a different wall clock every day and mismatched the documented
// 00:00/05:00 contract.
func TestQuota5hStartAnchoredToMidnight(t *testing.T) {
	cases := []struct {
		hour int
		want string
	}{
		{0, "00:00"}, {1, "00:00"}, {4, "00:00"},
		{5, "05:00"}, {9, "05:00"},
		{10, "10:00"}, {14, "10:00"},
		{15, "15:00"}, {19, "15:00"},
		{20, "20:00"}, {23, "20:00"},
	}
	base := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	for _, c := range cases {
		now := base.Add(time.Duration(c.hour) * time.Hour).Add(37 * time.Minute)
		got := quota5hStart(now).UTC().Format("15:04")
		if got != c.want {
			t.Errorf("quota5hStart(%02d:37) = %s, want %s", c.hour, got, c.want)
		}
	}
}

// TestQuota5hStartStableAcrossDays proves the fix removes the per-day drift: the
// same wall-clock hour maps to the same block start no matter the date.
func TestQuota5hStartStableAcrossDays(t *testing.T) {
	for d := 0; d < 4; d++ {
		now := time.Date(2026, 11, 9, 7, 15, 0, 0, time.UTC).AddDate(0, 0, d)
		got := quota5hStart(now).UTC().Format("15:04")
		if got != "05:00" {
			t.Fatalf("day+%d at 07:15 -> block start %s, want 05:00 (was drift-prone)", d, got)
		}
	}
}

// TestQuotaWindowStartMatchesPeriodTTL ensures the durable-sum fallback and the
// counter-key path still agree on the same period boundary after the fix.
func TestQuotaWindowStartMatchesPeriodTTL(t *testing.T) {
	now := time.Date(2026, 11, 10, 7, 30, 0, 0, time.UTC)
	_, ttl := quotaPeriodTTL("5h", now)
	if ttl != 6*time.Hour {
		t.Fatalf("5h TTL = %v, want 6h", ttl)
	}
	start := quotaWindowStart("5h", now)
	if start.UTC().Hour() != 5 || start.UTC().Minute() != 0 {
		t.Fatalf("quotaWindowStart(5h, %v) = %v, want 05:00", now, start)
	}
	// Both spell the same key.
	if keyA, _ := quotaPeriodTTL("5h", now); keyA != start.Format("200601021504") {
		t.Fatalf("period key %q != window start %q", keyA, start.Format("200601021504"))
	}
}
