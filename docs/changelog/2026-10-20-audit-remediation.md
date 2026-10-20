# Audit remediation: the router trusted values it had to verify

The Oct 20 audit found the same defect recurring across both planes: a value
that someone else controls, or that went stale, was trusted as if it were a
fact. An X-Forwarded-For header the caller sets decided how many brute-force
attempts each IP got. A spend counter key with no period in it outlived the
day it counted. A concurrency gauge with a 60-second TTL stopped enforcing
mid-stream on any request legitimately longer than a minute. A lookup row's
absence was read as "no rows" instead of "the database is broken". Each one
had a concrete failure already attached: false 402s, an unenforced auth-failure
cap, credentials that died upstream after a rotation race, a worker fleet that
crash-looped 32,801 times during the Oct 19 outage because two SQLSTATEs were
not classified as outages, and nightly "backups" that were zero-byte files.
This entry records every fix; the finding labels (H*, M*, 3x, AUTH-1, CRED-1)
are the audit's.

## What shipped

### Data plane (Go)

- **H1** — freebuff session state is keyed by `sha256(token)`
  (`freebuff/manager.go:70-78`) and the entry keyed by the *previous* token is
  evicted when a rotation lands (`:101-112`). The raw bearer token used to be
  the map key: every rotation left a dead entry behind (unbounded growth) and
  the secret sat in plain text in a key any panic dump would print.
- **H2** — the pool rebuild is a compare-and-swap (`proxy/proxy.go:391-406`).
  A bare `Store` let two concurrent rebuilds both persist their rotated
  refresh tokens; the loser's token died upstream and the account broke on its
  next expiry. CAS installs the fresh pool only while the stale one is still
  stored, so exactly one rotation persists and every loser re-Loads the
  winner's pool.
- **H3** — the concurrency gauge TTL widened 60s → 15m
  (`limits/limits.go:179-185`). 60s was shorter than a legitimate stream: the
  gauge expired mid-request, the cap silently stopped enforcing, and the slot
  the request still held was decremented into a fresh window. 15m matches the
  freebuff client's streaming budget.
- **H4** — every spend counter key now embeds the period start
  (`proxy/budget.go:139-152`, write side `:192-206`). The old
  `spend:{scope}:{id}:{day|month}` key had no period, and the day bucket's 25h
  TTL outlives the UTC day boundary: yesterday's counter was still live this
  morning and read as today's spend, producing false 402s until it aged out.
  Read and write spell the key alike — they must, or every write silently
  misses every read and the durable sum pays a Postgres round trip per
  request. The per-API-key counters in `limits/limits.go` carried the same
  bug and were fixed in the follow-up below (`periodSuffix`,
  `limits/limits.go:264`, used by both `Check` — `:168`, `:174` — and
  `SpendAdd` — `:238`).
- **H5** — `ttft_ms` is stamped on the first *token-bearing* `data:` frame
  (`proxy/stream.go:49-62`), not the first line: the router's own
  echo/keep-alive lines were forwarded before any payload existed, so
  stamping them reported `ttft_ms ≈ 0` and corrupted every dashboard
  percentile over that column. A non-EOF scanner error is now recorded even
  after the client disconnects (`:106-115`) — dropping it under
  `!clientDisconnected` lost the only evidence of a mid-stream upstream
  failure on exactly the requests that also show `client_disconnected`.
- **H6** — the generic passthrough rejects raw paths containing `..`, `%2e`
  or `%2f` (`proxy/generic.go:68-79`). Escaped dot-segments are not
  normalized by the mux, so a path like `/v1/%2e%2e/%2e%2e/admin` could
  escape the `/v1/` prefix on an upstream that decodes before routing. Query
  forwarding is deliberately unchanged — the endpoint-surface spec §6 P0
  documents the verbatim-forwarding contract.
- **H7** — the budget-rows read fails closed like the account read
  (`proxy/budget.go:60-64`). Spec §10 says an error on these rows refuses the
  request rather than admitting unbounded spend; failing open on exactly the
  rows that carry the caps would let a DB error bypass every budget the gate
  exists to enforce.
- **M-a** — the auth-failure limiter is keyed on the socket peer, not
  `clientIP(r)` (`proxy/auth.go:81-87`). `clientIP` walks X-Forwarded-For,
  which a caller behind the trusted proxy can set to a fresh value per
  request — each forged IP got its own 30/min budget and the brute-force cap
  enforced nothing. The peer host cannot be forged.
- **M-b** — key parsing caps both halves at 128 characters and requires
  `[A-Za-z0-9]` (`keys/keys.go:31-46`). Before this, attacker-chosen bytes of
  unbounded length reached the per-request sha256 (a cheap DoS) and control
  characters in the prefix flowed into logs and SQL lookups.
- **M-c** — a `rate_limited` credential carries a cooldown
  (`proxy/targets.go:200-221`, honouring the upstream's Retry-After when one
  was parsed, 60s otherwise). It used to set only the status, so a throttled
  credential was re-picked first after a pool rebuild and burned the request's
  pick budget on an account the upstream had just refused.
- **M-d** — the circuit breaker's save reads the TTL from the breaker config
  of the real target/id (`routing/execute.go:421-424`). The old call was
  `b.config("provider", "")` — a key that never exists in the cfg map, so
  every save silently used the default window and a per-target
  `WindowSeconds` was ignored on the write side.
- **M-e** — `CIRCUIT_OPEN` refusals are recorded but no longer count against
  `maxAttempts` (`routing/execute.go:92-95`). A refusal costs no upstream
  round trip, so counting it starved the fallback candidates: with
  `maxAttempts=2` and two open circuits ahead, the healthy third candidate was
  never reached.

### Control plane (Node)

- **AUTH-1** — the `/api/auth/*` handler runs before
  `express.json({limit:'1mb'})` and buffered the raw body with no size gate
  (`server/index.mjs:753-782`). A declared content-length over 1 MB is now
  413'd before a byte is read, and a chunked body is destroyed mid-stream at
  the same cap — reading it first would be the DoS the cap exists to stop.
- **CRED-1** — credential create lost its global-connection fallback
  (`server/admin.mjs:1895-1898`). The provider-scoped join was the only
  ownership check, and a miss used to fall back to `select id from
  connection`, which only failed when the row did not exist at all — a
  connection belonging to a different provider passed and the credential got
  attached to it.
- **3a** — mapping create scopes the connection to the provider
  (`server/admin.mjs:1222-1230`). Update already rejected a cross-provider
  connection; create accepted any existing one, so a mapping could point at
  one provider while spending a connection owned by another — the routing
  walk would call foreign credentials under this provider's name.
- **3b** — connection create/update/test pass `_allowPrivate()` to the SSRF
  guard like every other guard (`server/admin.mjs:1354`, `:1634`, `:1666`,
  `:1710`, `:1730`, `:1751`, `:1778`).
- **3c** — alert update and delete repeat the project+workspace ownership
  predicate on the write itself (`server/pages.mjs:1617-1624`,
  `:1637-1640`). The lookup row being yours proves nothing about the write:
  the row could change between the two statements, and a write anchored only
  by primary key lets any member with `alert.write` rewrite another project's
  alert.
- Invoice numbers use the full id (`server/pages.mjs:670-676`). The old
  6-hex-character suffix shared 2^24 values across every invoice row, so two
  ids agreeing in the last 6 characters collided on the UNIQUE `number`
  column and the insert died.
- **3d** — provider-enable clamps model prices to `MAX_PRICE_USD`
  (`server/admin.mjs:1657-1669`), re-exported from
  `server/lib/platform-ts.mjs:66` so both planes use one constant. The
  conversion previously had no upper bound: a payload could store an
  unbounded price the router bills from, and a value past the float boundary
  (`1e308 * 1e6 → Infinity`) threw an uncaught RangeError out of the handler.
- **3e** — the Discord fetch carries a 5s abort
  (`server/lib/discord.mjs:48-51`): a hung response held the caller's request
  open with no deadline, accumulating a fire-and-forget socket per call.

### Platform

- `packages/platform/server/workers.ts:1261-1323` treats `3D000` (database
  does not exist) and `42P01` (relation does not exist) as connection
  outages. Neither is a *connection* failure, but a database mid-restore
  serves exactly those codes, and while they were absent the claim+sweep
  error rethrew out of the guard and
  crash-looped the fleet 32,801 times during the Oct 19 outage. The outage
  classifier now reads the SQLSTATE from *every* node of the error chain —
  drizzle wraps the driver error, the SQLSTATE lives on the wrapped
  PostgresError's `code`, and only the chain tail's code was read before (the
  tail is an `Error`, so the code was silently dropped for exactly these
  codes). `warnMissingObject` logs the first occurrence of each code per
  process loudly, because 42P01 can also be a genuine migration bug and must
  not hide behind the backoff.
- `apps/scheduler/scheduler.mjs:93-100` prints `e.code` and the cause's code
  on tick failure. Message alone was not diagnosable: the Oct 19 outage logged
  100 consecutive failures with no code because drizzle's message carries the
  SQL while the SQLSTATE lives on `code`/`cause`.

### Ops

- `ops/backup-db.sh:21-35` dumps from the renamed container (`postgres-hardened`
  → `postgre`, overridable via `FUDROUTER_PG_CONTAINER`). Every nightly dump
  had been dying on `docker exec`, and because the shell had already created
  the output file for the redirect, a zero-byte `.sql` survived looking
  exactly like a backup. The output is now deleted on any failure, so an
  empty file can never be mistaken for one.

## Verified

- `npm run check` → exit 0 (tsc ×3, contracts lock `--check` OK: 7 inference
  + 191 management routes, structure gate PASS).
- Node suite → **134 tests, 128 pass, 0 fail, 6 skipped** (the skips are
  environmental: no local DSN/Valkey, per the harness's own gating).
- `go vet ./...` + `go build ./...` + `go test ./...` → **13/13 packages**.
- Go suite against a scratch database (same 13/13 packages, the DB-dependent
tests unskipped).

## Follow-up delta audit (same day)

A second pass over the same tree found the audit's own fixes incomplete in
four places. Each claim below is verified against the code it names.

- **Per-API-key spend keys were missed.** `limits/limits.go` still built
  `spend:api_key:<id>:day|month` with no period — the exact H4 bug already
  fixed for the workspace/project/environment budgets in
  `proxy/budget.go:139-152`. The day bucket's 25h TTL outlives the UTC day
  boundary, so yesterday's counter read as today's spend → false 402
  INSUFFICIENT_CREDITS for a key that spent its cap yesterday. Fixed with one
  shared `periodSuffix(suffix, now)` helper (`limits/limits.go:264-269`) used
  by BOTH `Check` (read, `:168` and `:174`) and `SpendAdd` (write, `:238`) so
  the two sides cannot spell the key differently — a mismatch makes every
  write miss every read and the cap pays a Postgres sum per request. New test
  `limits/spend_keys_test.go` pins read/write agreement and that a counter
  seeded under the old unperioded key misses into the durable sum.
- **Alert writes recorded audit rows they did not earn.** `pages.mjs`
  `alerts/update` and `alerts/remove` repeated the ownership predicate on the
  write (3c) but then returned success — and, for remove, wrote the
  `alert.delete` audit row — unconditionally: a row changing hands between
  lookup and write produced a zero-row DELETE plus a false audit entry. Both
  now use `returning id` and 404 on zero rows — update before returning
  success (`pages.mjs:1643-1645`), remove before the audit row
  (`:1660-1662`) — the shape `routing/update` (`:1388-1389`),
  `routing/delete` (`:1414-1415`) and `budgets/remove` (`:1865-1866`)
  already used.
- **Workspace-scoped budgets were listed but undeletable.** The budgets GET
  deliberately lists workspace rows (`or scope_id = ${workspaceId}`,
  `pages.mjs:1794`, labelled "Workspace (all projects)" at `:1811`), while
  `budgets/remove` accepted only project/environment scope ids — Delete
  always 404'd on every row that list displayed. Pre-existing, not
  introduced by the audit fixes. The ownership fragment now also accepts
  `scope = 'workspace' and scope_id = <workspace>` (`pages.mjs:1859`).
- **H3's severity was overstated.** The concurrency slot is decremented on
  release (`limits/limits.go:106-114`) and on refusal (`:205`), and the
  gauge's DECR floors at zero (`vk/vk.go:167-173`), so the 60s TTL only
  governed enforcement during streams longer than a minute and recovery of
  slots leaked by a crashed process. 15m fixes the first and makes the
  second block the cap 15m instead of 1m; documented at the call site
  (`limits/limits.go:182-190`).
- **Known residual, not fixed:** a transient DB error on the budget-rows
  read now fails closed (correct per spec §10, `proxy/budget.go:64-68`) but
  the caller maps every `checkBudgets` error to 402 INSUFFICIENT_CREDITS
  (`proxy/lifecycle.go:170-172`) — "out of money" when the truth is "could
  not verify"; a 503 would be truer. Pre-existing, same on the account read
  (`proxy/budget.go:46-49`).
- **Also record:** `ttft_ms = 0` is still indistinguishable from "no
  token-bearing frame arrived" — the relay uses `ttft == 0` as its unstamped
  sentinel (`proxy/stream.go:60`, `anthropic.go:696`) and drops a 0 at the
  end (`stream.go:117-119`), so a genuine sub-millisecond first token and a
  stream with no token frame both record NULL; there is no sentinel value
  that says "measured, zero". And freebuff's eviction can theoretically
  evict a live session under two concurrent rotations of the same base URL
  (`freebuff/manager.go:105-112`): `prevToken` holds one slot per base URL
  and the load-delete-store is not atomic, so a request carrying the older
  token can delete the newer token's live session — worst case the session
  is re-created on its next use.
