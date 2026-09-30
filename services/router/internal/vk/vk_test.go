package vk

import (
	"context"
	"errors"
	"testing"
	"time"
)

// An absent/empty VALKEY_URL is a CONFIGURATION, not a failure (spec §12): the
// client must disable cleanly and answer ErrDisabled, which callers read as
// "fall back to the S0 in-process limiter". The two outages must not be
// conflated: disabled = local enforcement, down = fail open.
func TestEmptyURLDisablesCleanly(t *testing.T) {
	for _, url := range []string{"", "   "} {
		c, err := New(url)
		if err != nil {
			t.Fatalf("New(%q) error = %v, want a clean disabled client", url, err)
		}
		ok, err := c.AllowRate(context.Background(), "rl:api_key:k:rpm", 1, time.Minute)
		if !ok {
			t.Error("disabled client must allow (the caller falls back, it does not deny)")
		}
		if !errors.Is(err, ErrDisabled) {
			t.Errorf("AllowRate err = %v, want ErrDisabled", err)
		}
		if _, err := c.IncrConc(context.Background(), "conc:api_key:k", time.Minute); !errors.Is(err, ErrDisabled) {
			t.Errorf("IncrConc err = %v, want ErrDisabled", err)
		}
		if err := c.DecrConc(context.Background(), "conc:api_key:k"); !errors.Is(err, ErrDisabled) {
			t.Errorf("DecrConc err = %v, want ErrDisabled", err)
		}
		var v int
		if err := c.GetJSON(context.Background(), "k", &v, 0); !errors.Is(err, ErrDisabled) {
			t.Errorf("GetJSON err = %v, want ErrDisabled", err)
		}
		if err := c.SetJSON(context.Background(), "k", v, time.Second); !errors.Is(err, ErrDisabled) {
			t.Errorf("SetJSON err = %v, want ErrDisabled", err)
		}
		if _, err := c.Lua(context.Background(), "return 1", "k", 1); !errors.Is(err, ErrDisabled) {
			t.Errorf("Lua err = %v, want ErrDisabled", err)
		}
	}
}

// A limit of "unlimited" (non-positive) must not dial the server at all: the
// allow decision for a no-limit key is a local one, and a dead Valkey must not
// slow every unlimited request. (The disabled client returns allow=true with
// ErrDisabled; the live client short-circuits before the round trip.)
func TestDisabledClientAllowsUnlimitedWithoutErrorSemantics(t *testing.T) {
	c := disabled{}
	ok, err := c.AllowRate(context.Background(), "rl:api_key:k:rpm", 0, time.Minute)
	if !ok {
		t.Error("a zero limit must allow")
	}
	// ErrDisabled still surfaces so the caller knows no counter was kept.
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("err = %v, want ErrDisabled (the caller records the fallback)", err)
	}
}

// The warning throttle must not log unbounded failures (spec §12: "at most one
// warning log per minute"). warn itself is the throttle; this pins that a
// burst collapses to at most one write inside the window — measured by the
// window's internal clock rather than by capturing log output.
func TestWarningThrottleIsRateLimited(t *testing.T) {
	ResetWarningWindowForTest()
	// First call arms the window; the next calls inside it are suppressed. We
	// cannot see log output here, but we CAN see the window state: after one
	// warn, the next window is in the future.
	warn("test %d", 1)
	warnMu.Lock()
	armed := warnNext
	warnMu.Unlock()
	if !armed.After(time.Now().Add(warnRate / 2)) {
		t.Errorf("warning window not armed for ~%v after a warning: %v", warnRate, armed)
	}
	// A suppressed warning must not extend the window (no starvation of the
	// once-per-minute guarantee under a flood).
	before := armed
	warn("flood")
	warnMu.Lock()
	after := warnNext
	warnMu.Unlock()
	if after != before {
		t.Error("a suppressed warning moved the next window — a flood would silence real warnings")
	}
	ResetWarningWindowForTest()
}
