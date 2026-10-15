# Production schema was four migrations behind the work in the tree

The uncommitted worker changes do not run on the deployed schema. Two of them
need objects production did not have:

- `credential_validation` orders by and writes `credential.last_validated_at` —
  without migration 0017 every probe run dies on `column "last_validated_at" does
  not exist`.
- `invoice_generation` upserts `onConflictDoNothing` on
  `(billing_account_id, period_start, period_end)` — without 0016's UNIQUE index
  Postgres refuses the statement with `there is no unique or exclusion constraint
  matching the ON CONFLICT specification`, so no invoice is issued at all.

Neither was live: the running worker fleet and router are the 4-day-old build, which
is why nothing had failed yet. Deploying the tree as it stood would have produced
both failures at once.

## What production actually held

Read from the production database (`current_database()` confirmed), not inferred from
the bookkeeping:

| | |
|---|---|
| `schema_migration` | 14 applied, 0010 gated, 0014–0017 pending |
| `model` rows with a `chat` capability key | **369** |
| `model` rows with `chat: false` | **92** |
| `system_setting['retention']` | `job_days: 30` present |
| `invoice` rows | 79 |
| `credential` rows | 40,621 |
| `request_log` rows | 1,100 |
| `job` rows | 35,387 |

So **0012 and 0013 were already in effect** — 0012's chat/modality classification
and 0013's `job_days: 30` are both present — while their names were absent from
`schema_migration`. That is the documented consequence of the live DB having been
shaped by `drizzle-kit push` and carrying no bookkeeping for those two: the effects
exist, the record does not. Reading the bookkeeping alone would have said "0012 is
missing", which is false, so this table is a record of what was *checked*, not of what
was *read*.

## Applied, in one run

`ops/migrate.sh` (the only migration path), as the application role:

| file | effect | pre-check |
|---|---|---|
| 0014_request_log_env_spend_idx | index, already present | — |
| 0015_retention_sweep_idx | 2 indexes on `request_log`, `job` | — |
| 0016_invoice_account_period | UNIQUE index on `invoice` | **0 duplicate (account, period) groups; 0 NULL keys** |
| 0017_credential_last_validated | `credential.last_validated_at` | PostgreSQL 18.6 — no default, so catalog-only |

`0010_platform_status_narrow` was skipped by the runner's `-- gated:` header, which is
the mechanism AGENTS.md describes: it narrows the status CHECKs while writers still emit
the pre-cutover literals. Verified after the run that the CHECKs still admit
`active`/`dev` — so a generic `ops/migrate.sh` run is safe, and the gate is what makes
it so.

The credential blob split at the end of the runner was skipped deliberately (no
`CREDENTIALS_MASTER_KEY` in the environment): it is unrelated to this change.

## Verified

- Objects present: the 3 indexes from 0014/0015, `invoice_account_period_idx`, and
  `credential.last_validated_at`.
- `ops/migrate.sh status`: `status: 18 applied`, with only `0010` reported `gated`.
- Nothing broke: the router still answers `/health` 200 and `/v1/models` with 342
  models, every console page answers 200, and the worker fleet is processing — the
  newest job was created 21s before the check and `completed` advanced
  35,415 → 35,417 in 45 seconds, with 1 failed job in the table's whole history.
- The stale `[workers] database unreachable (ECONNREFUSED)` line in the error log is
  from 2026-10-11 and predates this run; the out log's newest line is a completed job
  from today.
