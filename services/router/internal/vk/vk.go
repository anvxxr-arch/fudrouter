// Package vk is the data plane's Valkey access: rate-limit counters, in-flight
// gauges, spend counters, circuit state and small JSON caches.
//
// Contract (docs/specs/2026-09-30-platform-schema.md §12): Valkey is a
// CACHE/COUNTER LAYER ONLY — losing it must lose no business data. PostgreSQL is
// always authoritative. Two rules follow:
//
//  1. A connection failure degrades OPEN (allow) — the router must not turn a
//     cache outage into a customer outage — with at most one warning log per
//     minute, so a dead Valkey cannot flood the log at request rate.
//  2. An absent or empty VALKEY_URL disables the client cleanly. The sentinel
//     error ErrDisabled tells callers to fall back to their S0 in-process
//     limiter (still enforcing, still local) rather than to fail open — the two
//     outages have different answers and must not be conflated.
//
// Key namespaces are pinned by spec §12 (`rl:`, `conc:`, `spend:`, `circuit:`,
// …) and are spelled at the call sites in internal/limits, internal/routing and
// internal/proxy, not here.
package vk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	valkey "github.com/valkey-io/valkey-go"
)

// ErrNotFound is returned when a key does not exist (or holds no value). A
// caller treats it as "no cached value": recompute from PostgreSQL.
var ErrNotFound = errors.New("vk: key not found")

// ErrDisabled is returned by every method when VALKEY_URL is absent or empty.
// It is NOT a failure: it means "no cache layer configured", and the caller
// falls back to its in-process behaviour (spec §12).
var ErrDisabled = errors.New("vk: disabled (VALKEY_URL not set)")

// Client is the whole Valkey surface the data plane needs (spec §12).
//
// Semantics on failure:
//   - AllowRate returns (true, err) on any transport error: allow, and let the
//     caller log. A denied window returns (false, nil).
//   - IncrConc returns (0, err) on error; the caller must not use the count.
//   - DecrConc errors are safe to ignore (the gauge self-heals via its TTL).
//   - GetJSON returns ErrNotFound for a missing key and fills v otherwise.
//   - Lua returns the script's replies as []any (string/int64/nil/[]any).
type Client interface {
	AllowRate(ctx context.Context, key string, limit int, window time.Duration) (ok bool, err error)
	IncrConc(ctx context.Context, key string, ttl time.Duration) (int64, error)
	DecrConc(ctx context.Context, key string) error
	GetJSON(ctx context.Context, key string, v any, ttl time.Duration) error
	SetJSON(ctx context.Context, key string, v any, ttl time.Duration) error
	Lua(ctx context.Context, script, key string, args ...any) ([]any, error)
}

// EnvURL is the environment variable both planes read (spec §12).
const EnvURL = "VALKEY_URL"

// NewFromEnv builds the client from VALKEY_URL. An empty URL is the cleanly
// disabled client — a valid configuration, not an error.
func NewFromEnv() (Client, error) {
	return New(strings.TrimSpace(os.Getenv(EnvURL)))
}

// Disabled returns the cleanly disabled client (spec §12: absent/empty
// VALKEY_URL). Callers fall back to their in-process behaviour on ErrDisabled.
func Disabled() Client { return disabled{} }

// New builds a client for url. An empty url disables the client (spec §12).
func New(url string) (Client, error) {
	if strings.TrimSpace(url) == "" {
		return disabled{}, nil
	}
	opts, err := valkey.ParseURL(strings.TrimSpace(url))
	if err != nil {
		return nil, fmt.Errorf("vk: parse VALKEY_URL: %w", err)
	}
	c, err := valkey.NewClient(opts)
	if err != nil {
		return nil, fmt.Errorf("vk: connect: %w", err)
	}
	return &live{c: c}, nil
}

// disabled implements Client with no connection at all.
type disabled struct{}

func (disabled) AllowRate(context.Context, string, int, time.Duration) (bool, error) {
	return true, ErrDisabled
}
func (disabled) IncrConc(context.Context, string, time.Duration) (int64, error) { return 0, ErrDisabled }
func (disabled) DecrConc(context.Context, string) error                         { return ErrDisabled }
func (disabled) GetJSON(context.Context, string, any, time.Duration) error       { return ErrDisabled }
func (disabled) SetJSON(context.Context, string, any, time.Duration) error       { return ErrDisabled }
func (disabled) Lua(context.Context, string, string, ...any) ([]any, error) {
	return nil, ErrDisabled
}

// live is the valkey-go-backed client. Every command failure is (a) propagated
// to the caller, which degrades open, and (b) logged at most once per minute.
type live struct {
	c valkey.Client
}

// allowRateScript is a fixed-window counter: INCR, arm the window's TTL on the
// first hit, return the running count. The allow decision is `count <= limit`,
// made in Go so one script serves every limit.
//
// Fixed window (not sliding) is deliberate: one round trip, one key, and the
// skew is bounded by the window itself — the same shape the S0 in-process
// limiter uses, so the two agree when both are consulted.
var allowRateScript = valkey.NewLuaScript(`
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`)

var incrConcScript = valkey.NewLuaScript(`
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return v
`)

// decrConcScript floors the gauge at zero: a double release (or a release for a
// counter that already expired) must never make the gauge negative, or a
// concurrency limit would stop being a limit.
var decrConcScript = valkey.NewLuaScript(`
local v = redis.call('DECR', KEYS[1])
if v < 0 then redis.call('SET', KEYS[1], 0) return 0 end
return v
`)

func (l *live) AllowRate(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	if limit <= 0 {
		return true, nil // unlimited
	}
	res := allowRateScript.Exec(ctx, l.c, []string{key}, []string{formatMs(window)})
	if err := l.errOf(res.Error(), "AllowRate "+key); err != nil {
		return true, err // degrade OPEN
	}
	count, err := res.AsInt64()
	if err != nil {
		return true, l.errOf(err, "AllowRate "+key)
	}
	return count <= int64(limit), nil
}

func (l *live) IncrConc(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	res := incrConcScript.Exec(ctx, l.c, []string{key}, []string{formatMs(ttl)})
	if err := l.errOf(res.Error(), "IncrConc "+key); err != nil {
		return 0, err
	}
	n, err := res.AsInt64()
	if err != nil {
		return 0, l.errOf(err, "IncrConc "+key)
	}
	return n, nil
}

func (l *live) DecrConc(ctx context.Context, key string) error {
	res := decrConcScript.Exec(ctx, l.c, []string{key}, nil)
	return l.errOf(res.Error(), "DecrConc "+key)
}

// ttl on GetJSON is the CLIENT-SIDE cache hint (valkey-go's opt-in caching), not
// a server TTL: the server-side expiry is whatever SetJSON wrote. Zero disables
// client caching and always reads through. (The spec pins one signature for
// GetJSON/SetJSON; only SetJSON's ttl expires the entry.)
func (l *live) GetJSON(ctx context.Context, key string, v any, ttl time.Duration) error {
	var res valkey.ValkeyResult
	if ttl > 0 {
		res = l.c.DoCache(ctx, l.c.B().Get().Key(key).Cache(), ttl)
	} else {
		res = l.c.Do(ctx, l.c.B().Get().Key(key).Build())
	}
	s, err := res.ToString()
	if err != nil {
		return l.errOf(err, "GetJSON "+key)
	}
	if err := json.Unmarshal([]byte(s), v); err != nil {
		return fmt.Errorf("vk: unmarshal %s: %w", key, err)
	}
	return nil
}

func (l *live) SetJSON(ctx context.Context, key string, v any, ttl time.Duration) error {
	buf, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("vk: marshal %s: %w", key, err)
	}
	cmd := l.c.B().Set().Key(key).Value(string(buf))
	var res valkey.ValkeyResult
	if ttl > 0 {
		res = l.c.Do(ctx, cmd.Px(ttl).Build())
	} else {
		res = l.c.Do(ctx, cmd.Build())
	}
	return l.errOf(res.Error(), "SetJSON "+key)
}

func (l *live) Lua(ctx context.Context, script, key string, args ...any) ([]any, error) {
	strArgs := make([]string, len(args))
	for i, a := range args {
		strArgs[i] = fmt.Sprint(a)
	}
	var cmd valkey.Completed
	if key != "" {
		c := l.c.B().Eval().Script(script).Numkeys(1).Key(key).Arg(strArgs...)
		cmd = c.Build()
	} else {
		c := l.c.B().Eval().Script(script).Numkeys(0).Arg(strArgs...)
		cmd = c.Build()
	}
	res := l.c.Do(ctx, cmd)
	v, err := res.ToAny()
	if err != nil {
		return nil, l.errOf(err, "Lua")
	}
	switch t := v.(type) {
	case []any:
		return t, nil
	case nil:
		return nil, nil
	default:
		return []any{t}, nil
	}
}

// errOf maps a reply error into the package's vocabulary: a nil reply is
// ErrNotFound (a cache miss, not a failure) and anything else is a transport or
// server error, warned at most once per minute.
func (l *live) errOf(err error, op string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, valkey.Nil) {
		return ErrNotFound
	}
	warn("vk: %s: %v", op, err)
	return fmt.Errorf("vk: %s: %w", op, err)
}

func formatMs(d time.Duration) string {
	return fmt.Sprint(d.Milliseconds())
}

// warnRate is the maximum warning frequency for Valkey failures (spec §12:
// "at most one warning log per minute").
const warnRate = time.Minute

var (
	warnMu   sync.Mutex
	warnNext time.Time
)

// warn logs at most once per warnRate. A dead Valkey must not be able to flood
// the log at request rate — that turns a cache outage into a log-volume outage.
func warn(format string, args ...any) {
	warnMu.Lock()
	defer warnMu.Unlock()
	now := time.Now()
	if now.Before(warnNext) {
		return
	}
	warnNext = now.Add(warnRate)
	log.Printf("[vk] "+format+" (further Valkey warnings suppressed for %v)", append(args, warnRate)...)
}

// ResetWarningWindowForTest clears the warning throttle so a test can observe a
// warning without waiting a minute. Test-only.
func ResetWarningWindowForTest() {
	warnMu.Lock()
	defer warnMu.Unlock()
	warnNext = time.Time{}
}
