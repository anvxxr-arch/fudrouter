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
	// GetJSONMany reads every key in ONE round trip (MGET / pipeline), returning
	// the keys that were present. It exists because the read paths that touch the
	// whole candidate set — pricing for a `[NAME]/*` virtual is one lookup per
	// model in the catalogue — otherwise pay one round trip per element. A
	// missing key is simply absent from the result, not an error.
	GetJSONMany(ctx context.Context, keys []string, out map[string]json.RawMessage, ttl time.Duration) error
	// There is deliberately no general Lua method here any more.
	//
	// It existed so callers could run ad-hoc scripts, and the one shape that used
	// it was a fixed-window INCRBY counter — written four times (token windows,
	// budget spend, spend counters, plus a copy in the fake). Three of those
	// copies carried `if v == ARGV[1]`, which compares a Lua number against a
	// STRING, so the PEXPIRE never ran: the counters had no expiry at all. A
	// generic escape hatch meant no test could enumerate the scripts that needed
	// checking, and a fake that interprets intent could not catch it either. The
	// two shapes below are therefore the whole surface, each with one
	// implementation and one meaning.
	//
	// IncrByBucket adds weight to every key and arms each key's window TTL on its
	// first write, in ONE round trip, returning the post-increment totals in
	// KEYS order. A key that already exists keeps its TTL: the window belongs to
	// the first write.
	IncrByBucket(ctx context.Context, keys []string, weight int64, ttl time.Duration) ([]int64, error)
	// ReplaceBuckets overwrites every key with one value and TTL in ONE round
	// trip — the re-seed path after a cache miss.
	ReplaceBuckets(ctx context.Context, keys []string, value int64, ttl time.Duration) error
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
func (disabled) IncrConc(context.Context, string, time.Duration) (int64, error) {
	return 0, ErrDisabled
}
func (disabled) DecrConc(context.Context, string) error                    { return ErrDisabled }
func (disabled) GetJSON(context.Context, string, any, time.Duration) error { return ErrDisabled }
func (disabled) SetJSON(context.Context, string, any, time.Duration) error { return ErrDisabled }
func (disabled) IncrByBucket(context.Context, []string, int64, time.Duration) ([]int64, error) {
	return nil, ErrDisabled
}
func (disabled) ReplaceBuckets(context.Context, []string, int64, time.Duration) error {
	return ErrDisabled
}

// GetJSONMany completes the Client surface for the disabled configuration. It is
// spelled out rather than one-lined with the rest so the gofmt-aligned block
// above stays a block.
func (disabled) GetJSONMany(context.Context, []string, map[string]json.RawMessage, time.Duration) error {
	return ErrDisabled
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

// incrByBucketScript is the fixed-window INCRBY counter for N keys in ONE round
// trip: add this request's weight to every key, arm each key's window TTL on its
// FIRST write, and return the running totals in KEYS order.
//
// Why one script for all of them: the two callers below (token windows, spend
// counters) each incremented 2-6 keys with one Lua call per key, so a request
// paid 6 sequential round trips just to keep its counters current. One EVAL with
// several keys is one round trip and one atomic step.
//
// `tonumber(ARGV[1])` is load-bearing, not decoration. ARGV is always a string
// at the server, so `v == ARGV[1]` compares a Lua number against a string, which
// is FALSE in Lua, so PEXPIRE never ran and the counter never expired — a token
// cap that was reached once stayed reached forever. The comparison is against
// the weight, not against 1, because INCRBY's reply EQUALS the weight exactly on
// the first write; testing `v == 1` would break for weight 0, and testing
// `v == weight` on a pre-existing counter whose value happens to equal the
// weight would re-arm a TTL the window already had.
var incrByBucketScript = valkey.NewLuaScript(`
local first = tonumber(ARGV[1])
local out = {}
for i = 1, #KEYS do
  local v = redis.call('INCRBY', KEYS[i], ARGV[1])
  if v == first then redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
  out[i] = v
end
return out
`)

// IncrByBucket adds `weight` to every key and arms each key's TTL on its first
// write, in one round trip, and returns the post-increment totals in KEYS order.
// A key that already exists keeps its original TTL: the window belongs to the
// first write, and re-arming it on every write would let the window slide.
//
// The totals come back from the script rather than a follow-up GET: the caller
// (the token-window limiter) needs the post-increment value to make its allow
// decision, and reading it back would add the round trip this exists to save.
func (l *live) IncrByBucket(ctx context.Context, keys []string, weight int64, ttl time.Duration) ([]int64, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	res := incrByBucketScript.Exec(ctx, l.c, keys, []string{fmt.Sprint(weight), formatMs(ttl)})
	if err := l.errOf(res.Error(), "IncrByBucket"); err != nil {
		return nil, err
	}
	vals, err := res.AsIntSlice()
	if err != nil {
		return nil, l.errOf(err, "IncrByBucket")
	}
	return vals, nil
}

// replaceBucketScript overwrites N counters with one shared value and TTL, in one
// round trip. Used when a counter is re-seeded from the durable sum.
//
// It returns the key count: a script that returns nothing replies with a nil that
// the client maps to ErrNotFound, which would report a successful re-seed as a
// missing key.
var replaceBucketScript = valkey.NewLuaScript(`
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[1], 'PX', ARGV[2])
end
return #KEYS
`)

func (l *live) ReplaceBuckets(ctx context.Context, keys []string, value int64, ttl time.Duration) error {
	if len(keys) == 0 {
		return nil
	}
	res := replaceBucketScript.Exec(ctx, l.c, keys, []string{fmt.Sprint(value), formatMs(ttl)})
	return l.errOf(res.Error(), "ReplaceBuckets")
}

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

// GetJSONMany reads every key in ONE round trip.
//
// MGET is used rather than a pipeline of GETs so the values arrive in the order
// the keys were sent, which is what lets the caller decode without a second
// lookup, and so the command count is one either way — a pipeline would make the
// batching invisible in a command counter, which is exactly the kind of thing
// that regresses unnoticed.
//
// Absent keys are simply missing from `out`: an MGET miss is a normal cache
// miss, not an error, and the caller falls back to PostgreSQL for those keys
// only. The server-side TTL of each entry is whatever SetJSON wrote; the `ttl`
// argument here is the client-side cache hint, matching GetJSON.
func (l *live) GetJSONMany(ctx context.Context, keys []string, out map[string]json.RawMessage, ttl time.Duration) error {
	if len(keys) == 0 {
		return nil
	}
	var res valkey.ValkeyResult
	if ttl > 0 {
		res = l.c.DoCache(ctx, l.c.B().Mget().Key(keys...).Cache(), ttl)
	} else {
		res = l.c.Do(ctx, l.c.B().Mget().Key(keys...).Build())
	}
	vals, err := res.AsStrSlice()
	if err != nil {
		return l.errOf(err, "GetJSONMany")
	}
	if len(vals) != len(keys) {
		// valkey-go returns a nil element per missing key; a length mismatch means
		// the reply did not line up with the request, and pairing them by index
		// would silently hand one key's value to another. Fail instead: the caller
		// falls back to the DB for the whole set.
		return fmt.Errorf("vk: GetJSONMany returned %d values for %d keys", len(vals), len(keys))
	}
	for i, s := range vals {
		if s == "" {
			continue // missing key: nil in the reply, mapped to "" by the client
		}
		out[keys[i]] = json.RawMessage(s)
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
