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
	mu           sync.Mutex
	counts       map[string]*fakeWindow
	json         map[string]string
	bucketLevels map[string]*fakeBucket
	failAll      bool
	// hits/misses mirror the live client's cache tally so a test can assert the
	// hit rate the same way production reports it.
	hits   int64
	misses int64
}

type fakeBucket struct {
	tokens float64
	at     time.Time
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

// AllowBucket mirrors the token bucket closely enough for handler tests: it
// refills at the configured rate from the last touch and caps at burst, so a
// test that asks "does the platform rate hold?" sees rate semantics rather than
// a per-window count.
func (f *Fake) AllowBucket(_ context.Context, key string, ratePerSec float64, burst int) (bool, error) {
	if err := f.broken(); err != nil {
		return true, err // degrade OPEN
	}
	if ratePerSec <= 0 {
		return true, nil
	}
	if burst < 1 {
		burst = 1
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	levels := f.bucketLevels
	if levels == nil {
		levels = map[string]*fakeBucket{}
		f.bucketLevels = levels
	}
	b := levels[key]
	if b == nil {
		b = &fakeBucket{tokens: float64(burst), at: now}
		levels[key] = b
	}
	elapsed := now.Sub(b.at).Seconds()
	b.tokens = b.tokens + elapsed*ratePerSec
	if b.tokens > float64(burst) {
		b.tokens = float64(burst)
	}
	b.at = now
	if b.tokens < 1 {
		return false, nil
	}
	b.tokens--
	return true, nil
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
		f.misses++
		return ErrNotFound
	}
	f.hits++
	return json.Unmarshal([]byte(raw), v)
}

func (f *Fake) GetJSONMany(_ context.Context, keys []string, out map[string]json.RawMessage, _ time.Duration) error {
	if err := f.broken(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, k := range keys {
		if raw, ok := f.json[k]; ok {
			out[k] = json.RawMessage(raw)
			f.hits++
		} else {
			f.misses++
		}
	}
	return nil
}

// CacheStats mirrors the live client's tally so a test can assert the hit rate
// the same way production reports it.
func (f *Fake) CacheStats() CacheStats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return CacheStats{Hits: f.hits, Misses: f.misses}
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

// Del removes a cached entry. It exists because the console invalidates the
// router's API key cache on revoke (packages/platform/server/vk.ts
// invalidateApiKeyCache) and the test for that contract must be able to perform
// the same delete. A missing key is not an error, matching Redis DEL.
func (f *Fake) Del(_ context.Context, key string) error {
	if err := f.broken(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.json, key)
	return nil
}

// IncrByBucket mirrors the real script's window semantics for N keys.
//
// It deliberately does NOT take a script argument: it implements the documented
// behaviour (arm the TTL on the FIRST write, never re-arm), because the previous
// version of the single-key fake did exactly that while the real Lua compared a
// number against a string, never armed the TTL, and let every token-window
// counter live forever. A fake that interprets the script's INTENT cannot catch a
// script that does not do what it says — which is why the server-truthful
// behaviour is now stated here as the contract, and the real script is checked
// against a real server in vk's live tests.
func (f *Fake) IncrByBucket(_ context.Context, keys []string, weight int64, ttl time.Duration) ([]int64, error) {
	if err := f.broken(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	out := make([]int64, 0, len(keys))
	for _, key := range keys {
		w := f.counts[key]
		if w == nil || now.After(w.expires) {
			w = &fakeWindow{expires: now.Add(ttl)}
			f.counts[key] = w
		}
		w.count += weight
		f.json[key] = jsonScalar(w.count)
		out = append(out, w.count)
	}
	return out, nil
}

func (f *Fake) ReplaceBuckets(_ context.Context, keys []string, value int64, ttl time.Duration) error {
	if err := f.broken(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	for _, key := range keys {
		f.counts[key] = &fakeWindow{count: value, expires: now.Add(ttl)}
		f.json[key] = jsonScalar(value)
	}
	return nil
}

func jsonScalar(n int64) string {
	buf, _ := json.Marshal(n)
	return string(buf)
}
