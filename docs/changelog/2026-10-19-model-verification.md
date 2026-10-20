# Model verification: providers were never checked against their own catalog

`provider_model` rows are a **claim** copied from the upstream `/models`
listing. Nothing ever proved the upstream serves that slug under that name.
When a provider quietly swaps the backing model — relabels it, aliases it, or
serves a different capability tier — every user routed to it silently gets
wrong answers, and `request_log` cannot see it: it records `requested_model`
(what we asked for), never what came back. There was no evidence table, no
probe, and no surface to read one on.

## What shipped

A new `model_verification` job type in the platform worker fleet:

- **Probe**: one small deterministic chat completion (`max_tokens: 16`) per
  enabled `provider_model`, through the provider's own connection and
  decrypted credential — the same internal upstream seam the health check
  already uses (`guardedUpstreamFetch` + `headersFor`/`tokenAt` in
  `packages/platform/server/workers.ts`), never the public router hot path.
  The probe therefore consumes no user budget, hits no rate limiter, rotates
  no credential pool, and inherits the SSRF guard, no-redirect rule and
  timeout the health-check seam already carries.
- **Verdicts** (one append-only row per probe, migration
  `backend/go/migrations/0018_model_verification.sql`):
  - `pass` — 2xx and the response body's `model` field equals the requested
    slug. Strict string equality by design: a provider answering
    `gpt-4o-mini-2024-07-18` to `gpt-4o-mini` may be a legitimate dated
    snapshot or a swap — the job records the evidence
    (`requested_slug` vs `response_model`, tokens, latency), a human judges.
  - `mismatch` — 2xx but the upstream names a different model (or omits the
    field entirely: "will not say what it served" is not a pass).
  - `not_served` — 401/403/404: the credential cannot reach the model, so the
    catalog entry is fiction.
  - `error` — transient (5xx, 429, guard refusal, no usable credential).
    Deliberately a fourth value: collapsing it into `not_served` would flag a
    healthy model on every flaky probe, and dropping the row would hide the
    failure and leave a stale verdict standing.
- **Table** `model_verification`: append-only (the "latest verdict" read is
  max-by-`created_at`, never an UPDATE), `provider_model_id` is
  `ON DELETE SET NULL` so erasing a mapping keeps the record that the
  provider once served the wrong model — the survive-the-subject rule
  `request_log`'s ledger columns follow.
- **Scheduler**: daily fan-out, one job per enabled provider
  (`FAN_OUT` in `packages/platform/server/scheduler.ts`), mirroring
  `provider_model_sync` — both require `payload.providerId` and throw without
  it. Batch capped at `MODEL_VERIFICATION_BATCH` (100) per run,
  least-recently-verified first, so coverage rotates instead of re-probing
  the same head rows.
- **Admin endpoints** (`apps/web/server/admin.mjs`):
  - `GET /api/admin/providers/:id/verification` — latest verdict per
    mapping, `LEFT JOIN LATERAL` so never-probed mappings still appear
    (`verdict: null` = never checked, the state an operator most needs to
    see). Same shape `backend/go/internal/store/catalog.go` uses for latest
    pricing.
  - `POST /api/admin/providers/:id/verify` — enqueues through the platform
    `enqueue()` (exposed to the .mjs server as a lazy `_enqueueJob` on the
    `platform-ts.mjs` bridge, because `jobs.ts` imports `db/index.ts` which
    throws at import time without `DATABASE_URL`), inside the transaction with
    the `_audit` row. Never probes inline: a fleet-sized fan-out holds an HTTP
    request open for minutes and bypasses the worker's timeout/retry guards.

## Verified

- **New integration test** `apps/web/tests/integration/model-verification.test.mjs`
  against a stub upstream: all four verdicts (including the lying
  `response_model` as the evidence), the append-only contract (second run
  appends 5 rows, does not UPDATE the first 5), the SSRF private-IP seam, and
  cleanup. The 5xx→`error` assertion pins the must-never-become-`not_served`
  rule.
- **Gate 1** `DATABASE_URL=<scratch dsn> npm test --workspace apps/web`:
  **131 tests, 131 pass, 0 fail, 0 skipped** (0 skips because the run carries
  `CREDENTIALS_MASTER_KEY` and `VALKEY_URL` from `.env`).
- **Gate 2** `go vet ./... && go build ./...`: clean (no Go code changed —
  only the migration file, which is plain SQL).
- **Gate 3** `NODE_ENV=development npm run check`: tsc ×3 clean, contracts
  lock `--check` OK (7 inference + **191** management routes, +2 for the new
  endpoints; `routes.json`/`management.yaml` regenerated with the sanctioned
  scripts), structure gate PASS.
- Migration 0018 applied to the scratch test DB via `ops/migrate.sh`; gated
  0010 untouched.
