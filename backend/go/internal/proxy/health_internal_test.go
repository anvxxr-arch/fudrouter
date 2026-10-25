package proxy

import (
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
)

// Pure-logic tests for the health layer — no DB, no upstream. The end-to-end
// probe behaviour lives in health_test.go (external, full harness).

func TestAttachHealthAddsKnownEntriesOnly(t *testing.T) {
	view := map[string]HealthEntry{
		"a": {Status: "ok", LatencyMs: 12, CheckedAt: time.Now()},
	}
	obj := map[string]any{"id": "a"}
	attachHealth(obj, view)
	if _, ok := obj["health"]; !ok {
		t.Fatal("known slug must carry its health record")
	}
	foreign := map[string]any{"id": "b"}
	attachHealth(foreign, view)
	if _, ok := foreign["health"]; ok {
		t.Fatal("unknown slug must stay clean on the list view")
	}
}

func TestLastAttemptExtractors(t *testing.T) {
	var empty *lifecycle = &lifecycle{}
	if c := lastAttemptErrCode(empty); c != "no_attempt" {
		t.Fatalf("empty lifecycle err = %q, want no_attempt", c)
	}
	if l := lastAttemptLatency(empty); l != 0 {
		t.Fatalf("empty lifecycle latency = %d, want 0", l)
	}
	lc := &lifecycle{attempts: []*routing.Attempt{
		{ErrorCode: routing.ErrCodeProviderTimeout, LatencyMs: 77},
	}}
	if c := lastAttemptErrCode(lc); c != routing.ErrCodeProviderTimeout {
		t.Fatalf("err code = %q, want %q", c, routing.ErrCodeProviderTimeout)
	}
	if l := lastAttemptLatency(lc); l != 77 {
		t.Fatalf("latency = %d, want 77", l)
	}
	// A winning row has an empty ErrorCode — the extractor must not invent one.
	lc2 := &lifecycle{attempts: []*routing.Attempt{{ErrorCode: "", LatencyMs: 9}}}
	if c := lastAttemptErrCode(lc2); c != "no_attempt" {
		t.Fatalf("payload-only row err = %q, want no_attempt", c)
	}
}
