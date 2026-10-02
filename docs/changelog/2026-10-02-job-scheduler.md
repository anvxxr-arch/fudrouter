# The job queue gets a producer

Until now the platform had half a job system: `workers.ts` knew how to run 11
job types and `claimJobs` knew how to drain the `job` table, but **nothing ever
enqueued anything**. The worker was not even in `dump.pm2`. The word
"scheduler" appeared exactly once in the repository — in a comment claiming one
existed.

The visible cost was silent and spread out: `job` and `usage_hourly` sat at 0,
webhook deliveries were never sent, alerts were never evaluated, provider and
credential health checks never ran, invoices were never generated, and
`request_log` grew without bound because the retention cleanup never fired.
Dashboards for ranges of 7 days or more read `usage_daily`/`usage_hourly` and so
rendered nothing.

## Added

- `apps/web/src/lib/server/scheduler.ts` — the periodic scheduler. Due-ness is
  derived from the `job` table itself, so there is no cron table and no
  in-memory timer to lose across a restart: a scheduler that was down for a day
  catches up on its next tick, and a window that already ran is never re-run. A
  type that already has a `pending`/`running` row is skipped, so a stalled fleet
  applies backpressure instead of growing an unbounded queue. Intervals are
  measured from the last **finish**, not a fixed grid.
- `scripts/scheduler.mjs` and `scripts/run-scheduler.sh` — the PM2 app
  `fudrouter-scheduler`. It is a separate process from the worker fleet on
  purpose: a slow tick or a crash in scheduling must not stop the drain loop.
  Single-instance is a Valkey `lock:scheduler` (`SET NX PX`, refreshed each
  tick) that degrades open; the PostgreSQL in-flight check is the real guard, so
  losing Valkey cannot double-enqueue anything that matters.
- `scripts/ts-hooks.mjs` — the `$lib` alias resolver and TypeScript type-strip
  hooks, now shared by `workers.mjs` and `scheduler.mjs` instead of duplicated.
- `apps/web/src/lib/server/scheduler.test.ts` — 13 tests, including a schedule
  completeness guard: **every `JOB_TYPES` entry must be scheduled, except
  `pricing_sync`**, whose payload carries the proposed rules and whose bare form
  loops over an empty array. Adding a job type without scheduling it turns the
  suite red.

## Fixed

- **`credential_validation` no longer holds the fleet hostage.** It selected all
  ~12,044 credentials and issued one upstream probe (15s timeout) each, inside a
  single job row — while `WORKER_CONCURRENCY` defaulted to 1. That is not a job,
  it is an outage: one row blocked every other job for hours. It now fans out
  per connection (9 jobs), is bounded to 250 credentials per run, and orders by
  `last_used_at asc nulls first` — a probe stamps `lastUsedAt`, so the ordering
  is itself the cursor and no cursor state is persisted. Each job now finishes in
  about 8 seconds.
- **`WORKER_CONCURRENCY` raised to 4** in `ecosystem.config.cjs`. The claim loop
  uses `FOR UPDATE SKIP LOCKED`, so parallel workers are safe; at 1, a single
  slow handler is a single point of head-of-line blocking for the whole fleet.
- **`VALKEY_URL` was holding the `.env.example` placeholder.** `valkey_dev` is
  the literal 10-character value shipped in `infra/.env.example`, and it had
  been copied into `apps/web/.env` — so the acceleration layer had been dead.
  This stayed invisible because the client degrades open with at most one warning
  per minute, but the two failure modes are not equivalent: an *absent*
  `VALKEY_URL` returns `ErrDisabled` and the caller falls back to its enforcing
  in-process limiter, whereas a *failing* connection degrades open and enforces
  nothing. A wrong password was therefore strictly worse than no password.

## Verified

- 874 web tests pass across 58 files (was 861 across 57); `svelte-check` reports
  0 errors; all 13 Go packages pass.
- The scheduler enqueues on cadence in production, the worker drains it, and
  `usage_hourly` / `usage_daily` / `system_event` climb as a result.
- Three negative controls confirm the tests test something: forcing `inFlight`
  to return `false`, forcing the not-due comparison to `if (false)`, and dropping
  `where enabled = true` from the fan-out SQL each turn the suite red.
- Reboot survivability is proven rather than assumed: `pm2 delete all` followed
  by `pm2 resurrect` brings all four apps back from `dump.pm2` alone.
