package vk

// fakeClient is the window-logic stand-in the limits package's tests exercise
// against: a real fixed-window counter with the same semantics the Lua
// scripts implement in the live client (INCR + PEXPIRE on first hit).
//
// It lives in the vk package (not in limits) because the SEMANTIC being faked
// is vk's: one window per key, TTL armed on first hit, count reported before
// the limit comparison. A fake with different window semantics would let a
// regression in AllowRate's contract pass unnoticed.

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// Fake is an in-memory vk.Client. Tests use it to drive the limits/routing
// packages without a Valkey server.
type Fake struct {
	mu      sync.Mutex
	counts  map[string]*fakeWindow
	json    map[string]string
	failAll bool
}

type fakeWindow struct {
	count   int64
	expires time.Time
}

func NewFake() *Fake {
	return &Fake{counts: map[string]*fakeWindow{}, json: map[string]string{}}
}

// FailAll switches the fake into "transport error" mode: every call returns a
// non-nil, non-ErrDisabled error, exactly like a dead server. Callers must
// degrade OPEN on that (spec §12) — different from ErrDisabled.
func (f *Fake) FailAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAll = true
}

// ErrTransport is the synthetic transport failure the fake returns.
type ErrTransport struct{}

func (ErrTransport) Error() string { return "fake: transport failure" }

func (f *Fake) broken() error {
	if f.failAll {
		return ErrTransport{}
	}
	return nil
}

func (f *Fake) AllowRate(_ context.Context, key string, limit int, window time.Duration) (bool, error) {
	if err := f.broken(); err != nil {
		return true, err // degrade OPEN
	}
	if limit <= 0 {
		return true, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w := f.counts[key]
	now := time.Now()
	if w == nil || now.After(w.expires) {
		w = &fakeWindow{expires: now.Add(window)}
		f.counts[key] = w
	}
	w.count++
	return w.count <= int64(limit), nil
}

func (f *Fake) IncrConc(_ context.Context, key string, ttl time.Duration) (int64, error) {
	if err := f.broken(); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w := f.counts[key]
	now := time.Now()
	if w == nil || now.After(w.expires) {
		w = &fakeWindow{expires: now.Add(ttl)}
		f.counts[key] = w
	}
	w.count++
	return w.count, nil
}

func (f *Fake) DecrConc(_ context.Context, key string) error {
	if err := f.broken(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if w := f.counts[key]; w != nil && w.count > 0 {
		w.count--
	}
	return nil
}

func (f *Fake) GetJSON(_ context.Context, key string, v any, _ time.Duration) error {
	if err := f.broken(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, ok := f.json[key]
	if !ok {
		return ErrNotFound
	}
	return json.Unmarshal([]byte(raw), v)
}

func (f *Fake) SetJSON(_ context.Context, key string, v any, _ time.Duration) error {
	if err := f.broken(); err != nil {
		return err
	}
	buf, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.json[key] = string(buf)
	return nil
}

func (f *Fake) Lua(ctx context.Context, script, key string, args ...any) ([]any, error) {
	if err := f.broken(); err != nil {
		return nil, err
	}
	// The two scripts the limits package runs are fixed-window INCRBY counters;
	// the fake implements that one shape.
	if key != "" && len(args) >= 1 {
		weight := toInt64Or(args[0], 1)
		ttl := time.Duration(toInt64Or(args[1], int64(time.Minute))) * time.Millisecond
		f.mu.Lock()
		defer f.mu.Unlock()
		w := f.counts[key]
		now := time.Now()
		if w == nil || now.After(w.expires) {
			w = &fakeWindow{expires: now.Add(ttl)}
			f.counts[key] = w
		}
		w.count += weight
		// Mirror the counter into the JSON store: real Valkey has ONE value per
		// key, so a GetJSON after an INCRBY must see it (the spend fast path
		// reads its own counter that way).
		f.json[key] = jsonScalar(w.count)
		return []any{w.count}, nil
	}
	return []any{nil}, nil
}

func jsonScalar(n int64) string {
	buf, _ := json.Marshal(n)
	return string(buf)
}

func toInt64Or(v any, def int64) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	}
	return def
}
