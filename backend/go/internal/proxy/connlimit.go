package proxy

import (
	"context"
	"sync"
	"time"
)

// connLimiter is a per-connection WINDOW counter, not a token bucket.
//
// The distinction is the whole point. A token bucket enforces an AVERAGE rate:
// 12 rpm with burst 2 happily lets a third request through 2s later, because the
// average allows it. Providers do not work that way — OVHcloud AI Endpoints
// allows 2 requests per rolling 5s window, so the third request inside that
// window is a 429 no matter how far below the hourly average it is. Measured on
// the live endpoint: requests 1-2 answer 200, request 3 at t+2s answers 429, and
// the window frees up ~5s after the first request.
//
// A 429 here is expensive: the router parks the credential (60s cooldown), the
// candidate pool for that connection empties, and every model on it then fails in
// microseconds with a decrypt error that has nothing to do with the cause. So the
// gate models the provider's window exactly instead of approximating it.
//
// Connection config:
//
//	{"rpm": 24, "burst": 2, "window_ms": 5000}
//
// burst = requests allowed per window, window_ms = window length (default 60s,
// which makes rpm/burst a plain per-minute limit). Process-local on purpose: it
// models the LOCAL egress address, and one router process = one egress.
type connLimiter struct {
	mu      sync.Mutex
	windows map[string]*connWindow
}

type connWindow struct {
	start time.Time
	used  int
}

func newConnLimiter() *connLimiter {
	return &connLimiter{windows: make(map[string]*connWindow)}
}

// windowSpec is the pacing budget for one connection. A zero burst means no gate.
type windowSpec struct {
	burst  int
	length time.Duration
}

func specFor(rpm, burst, windowMs int) windowSpec {
	if rpm <= 0 {
		return windowSpec{}
	}
	length := time.Duration(windowMs) * time.Millisecond
	if length <= 0 {
		length = time.Minute
	}
	if burst <= 0 {
		burst = rpm
	}
	return windowSpec{burst: burst, length: length}
}

// take consumes one slot in the current window, reporting how long the caller
// must wait for the next window to open when this one is full.
func (l *connLimiter) take(id string, spec windowSpec) (bool, time.Duration) {
	if l == nil || spec.burst <= 0 {
		return true, 0
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	win, ok := l.windows[id]
	if !ok || now.Sub(win.start) >= spec.length {
		l.windows[id] = &connWindow{start: now, used: 1}
		return true, 0
	}
	if win.used < spec.burst {
		win.used++
		return true, 0
	}
	return false, spec.length - now.Sub(win.start)
}

// admitWait blocks until a slot opens or the caller's patience runs out.
//
// Waiting beats answering 429 for a single-candidate model: the provider serves
// the request one window later, while a 429 parks the credential for a full
// cooldown and drops every model on the connection from the catalogue.
func (l *connLimiter) admitWait(ctx context.Context, id string, spec windowSpec, patience time.Duration) bool {
	if l == nil || spec.burst <= 0 {
		return true
	}
	deadline := time.Now().Add(patience)
	for {
		ok, wait := l.take(id, spec)
		if ok {
			return true
		}
		if time.Now().Add(wait).After(deadline) {
			return false
		}
		if wait < 20*time.Millisecond {
			wait = 20 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
	}
}
