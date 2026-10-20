# The SSE no-buffering rule was stated in AGENTS.md and asserted nowhere

`AGENTS.md:304-305` carries the rule — "**SSE must not be buffered** — anything
that buffers breaks TTFT and the `ttft_ms` column" — and until now nothing in the
suite asserted it. The two existing streaming tests both read the stream to
COMPLETION before looking at anything: `stream_test.go`'s
`TestStreamNotCutByClientTimeout` (stream_test.go:19) and
`generic_bounded_test.go`'s `TestGenericEventStreamIsNotTruncated`
(generic_bounded_test.go:104). A relay that accumulated the whole upstream body
and wrote it at the end passes both: every chunk still arrives, in order, with
`[DONE]`. The only observable difference is WHEN the first byte lands, and that
is exactly what those tests never look at.

## Why a buffering relay is a silent, total regression

`ttft_ms` is measured from `streamStart` to the first relayed line
(stream.go:49-51), so a buffering relay records the upstream's TOTAL generation
time as TTFT — a 30s answer reports `ttft_ms=30000` instead of ~200. Every
dashboard percentile over that column is then wrong, and the client sees no
tokens until the answer is already complete, which is the one thing a streaming
API exists to avoid. The bytes are identical, the status is `success`, the
`[DONE]` terminator arrives: the regression ships green and degrades every
streaming request.

## The gate

`backend/go/internal/proxy/stream_ttft_test.go` (new, untracked) is table-driven
over both relays, because the flush-per-line shape is duplicated rather than
shared: `streamSSE` (stream.go:23) for the OpenAI chat path and
`anthropicStreamSSE` (anthropic.go:518) for the Anthropic surface. A buffering
regression in either one is the same defect, and a gate that covered only the
first would leave the second shipping green.

The assertion is ORDERING, never latency: the client must observe the first
event BEFORE the upstream signals completion. The upstream blocks on a channel
the test only closes at the very end, so "before completion" is a happens-before
relation, not a stopwatch. The generous timeouts — 10s first-event
(`firstEventTimeout`, stream_ttft_test.go:72), 20s upstream-block
(`upstreamBlockTimeout`, stream_ttft_test.go:77) — are there so a loaded box
cannot make this flake: a slow machine delays both sides equally and the ordering
still holds.

## Three design decisions

**1. A real `httptest.Server`, not a `ResponseRecorder`.** The recorder
implements no `http.Flusher`, so the relays' flush is a no-op and every event
lands in one buffer — `generic_bounded_test.go:100-103` records this trap. A
recorder would make the test pass for a reason that has nothing to do with the
relay.

**2. The relays are driven directly through `export_test.go` hooks**
(`StreamSSEForTest`, export_test.go:136; `AnthropicStreamSSEForTest`,
export_test.go:145) rather than through `ServeCompletions`, because admission
(auth, limits, budget, model resolution) needs a seeded database and the property
under test lives entirely inside the relay loop. A gate that had to seed a
database to assert a property of the copy loop would be skipped on every DB-less
run, which is most of them. What this gate does NOT cover is the wiring that
chooses the streaming branch — that is `ServeCompletions`' `if stream`
(proxy.go:313-316) and generic.go:165-168, which the DB-backed tests already
exercise end to end.

**3. The Anthropic relay emits `message_start` BEFORE it reads a single upstream
byte** (anthropic.go:541-552), so "the client got an event" is not by itself
evidence of streaming there — a buffering relay still emits `message_start`
immediately. The event that proves the relay is forwarding as it reads is the
first one derived from upstream DATA, which is what `readUntil`
(stream_ttft_test.go:150-158) waits for: `"content":"first"` for the chat relay,
`"text":"first"` for the Anthropic one.

## Mutation sensitivity — the gate was proven to fail

All three relay surfaces were mutated to buffer the entire upstream body before
writing anything, and all three went red:

| surface | mutation | subtest | result |
|---|---|---|---|
| `stream.go` `streamSSE` | read whole body, then write | `chat completions relay` | **FAIL** |
| `anthropic.go` `anthropicStreamSSE` | read whole body, then write | `anthropic messages relay` | **FAIL** |
| `apps/web/server/playground.mjs` relay | read whole body, then write | `playground-stream.test.mjs` | **FAIL** |

The `playground.mjs` mutation manifests as a hang rather than an assertion
failure — the client's first `reader.read()` never resolves
(playground-stream.test.mjs:132-134), so the test times out. That is the
regression's true signature, not a test defect; it is bounded with
`--test-timeout=30000` to produce a reportable FAIL.

## Restoration

`stream.go` and `anthropic.go` were restored byte-for-byte: `git diff --stat`
empty for both, and `git hash-object` equals `git rev-parse HEAD:<path>` for
both. `playground.mjs` retains its genuine uncommitted feature work (+205/-10:
the `/api/playground/compare` N-model fan-out relay, the `req.on('close')` →
`res.on('close')` disconnect-signal fix, and the `status` field threaded through
`PG_EMPTY_METRICS` / `pgFetchRunMetrics` / `request_log`) — that is live work,
not a mutation artifact. No `.orig` / `.bak` / `.mut` leftovers in the tree.

## The gate runs without a database

`deadStoreDSN` (export_test.go:101) points at `127.0.0.1:1`, so `store.New`
parses the DSN and builds the pool without dialing. That makes `finish()`'s
ledger write fail fast (~1ms) instead of hanging, which is what lets the relay
be gated with no seeded database at all. The expected log noise is
`[proxy] charge failed` / `[proxy] request_log insert failed` with connection
refused; those are logged errors, not test failures.

## Verified

- `GOTOOLCHAIN=auto env -u DATABASE_URL go test ./internal/proxy/ -run TestSSEFirstEventArrivesBeforeUpstreamCompletes -count=1 -v`
  → **PASS**, both subtests (`chat completions relay`, `anthropic messages
  relay`), exit 0, **0.012s**.
- Full proxy package: `GOTOOLCHAIN=auto env -u DATABASE_URL go test ./internal/proxy/ -count=1`
  → **ok**, **8.546s**, exit 0.
- `GOTOOLCHAIN=auto go vet ./...` → exit 0; `GOTOOLCHAIN=auto go build ./...` → exit 0.
- `NODE_ENV=development npm run check` → exit 0 (tsc ×3, contracts: 7 inference +
  189 management routes match, structure: PASS).
- `env -u DATABASE_URL NODE_ENV=development npm test` → **120 tests, 80 pass,
  0 fail, 40 skipped** (39 integration without a throwaway `DATABASE_URL`,
  2 `VALKEY_URL`, 1 bare skip).
- Mutation: all three relay surfaces red under a buffering mutation; all three
  restored byte-exact.
