# Configurable provider health-check cadence

**Date:** 2026-10-26
**Status:** approved to build
**Size:** small change

## Intent

The `provider_health_check` job probes every enabled connection's `base_url`
every 5 minutes and refreshes `connection.health_status`. That cadence is a
hardcoded constant (`scheduler.ts:95`), so changing it needs a code edit and a
deploy.

An operator who wants tighter detection — because the router serves many
people and a dead provider costs a full upstream timeout on the first request
per attempt — currently cannot get it without shipping code.

The goal: let an admin change the cadence from the console, effective on the
next scheduler tick, without a restart.

## Why now

fudrouter is being prepared for multi-tenant use. The failover machinery is
already sound (deadline-aware attempts, circuit breaker that fails open,
retryable upstream 401/403, credential cooldown honouring `Retry-After`). What
the health probe adds is *prevention*: a provider marked `unhealthy` is
excluded from the candidate set before a request pays for it.

The probe exists and works — production shows 15 healthy / 2 unhealthy
connections and six `provider.degraded`/`provider.recovered` transitions in
four hours. Only its cadence is fixed.

## Goals

- An admin can read and change the health-check interval from the console.
- A change takes effect on the next scheduler tick (≤15s), with no restart.
- The interval is clamped to a sane floor so a typo cannot banjiri 17
  providers.
- Absent or malformed setting falls back to today's 5 minutes, so behaviour
  on a fresh database is unchanged.

## Non-goals

- Per-provider cadence. One interval for all connections; the fan-out already
  runs one job per connection.
- Making the other seven periodic jobs configurable. Only
  `provider_health_check` is in scope.
- A "probe now" button. Manual triggering already exists through
  `_enqueueJob('provider_health_check', { connectionId })`; a UI for it is a
  separate, smaller change.
- Retrying the probe on failure inside one run. The 5-minute (or configured)
  cadence is the retry.

## Anti-goals

- A setting that silently does nothing because the scheduler cached it at
  boot. That is the failure mode this design exists to avoid.
- A floor so low that the probe itself becomes the outage. 17 connections at a
  10s cadence is 102 requests/minute of pure probe traffic.
- A new settings mechanism. `system_setting` + `getSetting`/`setSetting` is
  the established pattern (`retention`, `maintenance`, `registration` already
  use it); this reuses it.

## Constraints

- `schedulerTick` is deliberately testable with injected `now` and `schedule`
  and no database. The change must not make a database read mandatory for
  every tick.
- `entry.everyMs` is read in two places: the periodic branch
  (`scheduler.ts:253`) and inside the `fanOutTargets` SQL
  (`scheduler.ts:216`). `provider_health_check` is a **periodic** entry, so
  only the first is in scope.
- The scheduler runs as a single PM2 process guarded by a Valkey lock; there
  is no multi-replica concern for the cadence itself.

## Approaches considered

**A. Read the setting once at startup, patch the entry, then tick as today.**
Smallest diff. Downside: a change needs a scheduler restart, which is the
thing being complained about.

**B: Read the setting on every tick, override the entry's `everyMs`.**
Effective immediately. Costs one indexed primary-key read per 15s tick —
negligible against the tick's existing queries (`inFlight` + `lastTerminalAt`
per entry). Chosen.

**C: Keep the constant, add only a manual "probe now" button.**
Useful, and already half-built through `_enqueueJob`, but it does not answer
"make detection tighter" — it answers "let me react now". Different job.

## Design

### Setting

New key in `system_setting`:

```
provider_health_check: { "everyMs": 300000 }
```

- Seeded by migration `0023` with `300000` (today's value), so an existing
  database behaves identically until someone changes it.
- Added to `SystemSettings` in `packages/platform/server/settings.ts` as
  `{ everyMs: number } | null`.

### Clamp

One exported helper in `scheduler.ts`:

```ts
export const HEALTH_CHECK_MIN_MS = 60_000;   // 1 minute floor
export const HEALTH_CHECK_MAX_MS = 30 * 60_000; // 30 minute ceiling
export function clampHealthCheckMs(v: unknown): number
```

- Non-number, `NaN`, `<= 0`, or out of range → the default (5 min). Fails
  closed to today's behaviour rather than to the nearest bound, so a garbage
  value is visibly inert instead of silently becoming 1 minute.
- The floor is 60s: at 17 connections that is 17 probe requests/minute, the
  same order as one busy tenant's traffic. The ceiling stops a value like
  `86400000` from quietly disabling the probe.

### Scheduler

`schedulerTick` gains an optional resolver, defaulting to today's constant:

```ts
export async function schedulerTick(
  handle: JobHandle = db,
  now: Date = new Date(),
  schedule: readonly ScheduleEntry[] = SCHEDULE,
  resolveEveryMs?: (type: string, fallback: number) => Promise<number>
): Promise<TickResult>
```

- The periodic branch calls `resolveEveryMs(entry.type, entry.everyMs)` when
  provided; otherwise it uses `entry.everyMs` exactly as today. Existing
  callers and tests are untouched.
- The `fanOut` branch is unchanged — no fan-out job is configurable in this
  change, so `entry.everyMs` stays authoritative there.

`apps/scheduler/scheduler.mjs` passes a resolver that reads the setting once
per tick:

```js
const { getSetting } = await import('@fudrouter/platform/server/settings.ts');
const result = await schedulerTick(db, new Date(), SCHEDULE, async (type, fallback) => {
  if (type !== 'provider_health_check') return fallback;
  const s = await getSetting('provider_health_check');
  return clampHealthCheckMs(s?.everyMs ?? fallback);
});
```

- A settings read failure propagates into the tick's existing try/catch, which
  already logs with SQLSTATE and retries next tick. It does not crash the
  scheduler — that behaviour is already pinned by the Oct 19 outage comment.
- One read per tick, not per entry: the resolver is only consulted for the
  one configurable type.

### Admin surface

- `PATCH /api/admin/settings` already persists `system_setting` rows; the new
  key rides the same route. No new endpoint.
- `apps/web/src/routes/settings.tsx` gains one numeric field, labelled in
  **minutes** (humans do not think in milliseconds), with the 1–30 range
  stated in the helper text.
- The field writes `everyMs = minutes * 60000`.

### Migration

`backend/go/migrations/0023_provider_health_check_setting.sql`:

```sql
INSERT INTO "system_setting" ("key", "value") VALUES
  ('provider_health_check', '{"everyMs": 300000}'::jsonb)
ON CONFLICT ("key") DO NOTHING;
```

`DO NOTHING` so a re-run never overwrites an operator's chosen value.

## What this touches

| File | Change |
|---|---|
| `backend/go/migrations/0023_*.sql` | new, seed the key |
| `packages/platform/server/settings.ts` | add the key to `SystemSettings` |
| `packages/platform/server/scheduler.ts` | clamp helper + optional resolver |
| `apps/scheduler/scheduler.mjs` | pass the resolver |
| `apps/web/src/routes/settings.tsx` | one numeric field |
| `apps/web/server/admin.mjs` | none — existing settings route covers it |

## Left to the builder

- Exact wording of the settings field label and helper text.
- Whether to show the current effective cadence next to the field (recommended:
  yes, one line, so an operator can confirm a save landed).
- Test placement: there is no existing unit-test suite for
  `packages/platform` (only `packages/contracts/test` and
  `apps/web/tests/integration`). The clamp helper is pure and cheap to test;
  a new `packages/platform/test/scheduler.test.mjs` following the contracts
  test's runner is the natural home. If that proves awkward, pinning the clamp
  through an integration test is acceptable.

## Verification plan

- Clamp: `0`, `-1`, `NaN`, `"abc"`, `null`, `undefined`, `59000`, `300000`,
  `1800001` all resolve to the expected value (default, floor, or ceiling).
- `schedulerTick` with no resolver behaves exactly as today (existing
  integration tests stay green).
- `schedulerTick` with a resolver returning `60000` enqueues
  `provider_health_check` when the last run was 90s ago, and skips it at 30s.
- Full Go suite + `apps/web` integration suite green.
- On the deployed box: set the value to 1 minute, watch `job` rows for
  `provider_health_check` arrive roughly a minute apart, then restore 5
  minutes.
