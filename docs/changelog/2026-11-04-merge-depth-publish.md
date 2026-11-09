# Phase log — merge-depth publish, one proven pair (2026-11-04)

Target: raise routing **depth** for one identity by publishing a
(canonical model × provider) pair that a real chat completion proved callable —
and make the migration's own evidence, guard, idempotence and rollback testable
rather than asserted.

Depth is the HA metric: a single-provider identity dies with that provider's
rate-limit, which is the `CIRCUIT_OPEN` storm in the ledger. The catalogue is
overwhelmingly depth-1 — measured on production, 2026-11-04 03:44 UTC, both
queries in one transaction so they share a single `now()`:

| depth | identities |
|---|---|
| 1 | 114 |
| 2 | 7 |
| 3 | 2 |

123 servable identities, 114 of them single-provider. Publishing one *proven*
pair is the smallest honest step against that, and it is deliberately not a bulk
operation — the reasoning is below.

**Depth is time-varying, and that is the most important thing this card learned.**
The predicate counts providers that are *dialable right now*: enabled provider,
enabled connection, not `unhealthy`, and at least one credential that is neither
disabled nor cooling. An identity can therefore move between depth 1 and 2 as a
single key's cooldown expires and re-arms. `gemma-4-31B-it` was measured at depth
2 at 03:41 and depth 1 at 03:44 for exactly this reason — SambaNova's only
credential flaps between `rate_limited` and available every few minutes. A depth
number without a timestamp is not a measurement; both verifiers here run in one
transaction for that reason.

## What shipped

| Phase | Deliverable | Evidence |
|---|---|---|
| Probe | `ops/merge-depth-probe.mjs` — one real chat completion per candidate pair, three states (PASS / KEY / DEAD), writes no DB rows | 38 candidates narrowed to 1 PASS |
| Verify | `ops/merge-depth-verify.mjs` — same rule with per-provider key fan-out and negative controls | 2 negative controls → 404 |
| Plan | `ops/merge-depth-plan.mjs` — builds the candidate list from `/models` membership | `/models` is the filter, never the proof |
| Migration | `0030_merge_depth_publish.sql` — exactly one pair, guarded, idempotent, audited | `prv_googleai` + `models/gemma-4-31b-it` → 200 |
| Rollback | `ops/rollback/0030_merge_depth_publish.rollback.sql` — audit-driven undo, not a hardcoded id list | `TestMergeDepthRollbackRestoresCatalogue` |
| Tests | `internal/store/merge_depth_test.go` — 3 tests / 5 assertions over migration + rollback, plus a pollution control | 3/3 pass; store package green |

## Why a probe and not `/models`

An aggregator lists what it **sells**, not what a pooled key may **call**.
Measured on this catalogue: `free.ai` publishes **466 ids** on `GET /v1/models`,
but every premium id answers

```
400 "'<id>' is not served by this endpoint"
```

to `POST /chat/completions`, because premium traffic lives on an upstream path
this router does not dial. Publishing those rows would have put **31 mappings**
in the candidate fan-out that cannot serve a single request — depth on paper,
dead weight in production. `/models` membership is the candidate *filter*; a chat
completion is the *proof*.

Of 38 name-matched candidates, exactly one answered:

```
prv_googleai + models/gemma-4-31b-it  -> 200, usage present
prv_googleai + gemma-4-31B-it         -> 400 "unexpected model name format"
bogus id on prv_googleai              -> 404   (negative control)
bogus id on prv_tokenjuice            -> 404   (negative control)
```

The unprefixed id failing with a *different* error is what proves the `models/`
prefix is required rather than incidental. Both negative controls returning 404
is what proves a PASS is not vacuous.

**What a 2xx does NOT claim.** A 2xx proves the mapping *resolves*. It says
nothing about reliability or sustained availability: `status='available'` means
"callable now", not "healthy". Reliability stays with `model_verification` and
`request_attempt` history. The migration header says this in full because the
distinction is the one a future reader is most likely to blur.

## Contract impact: none

No new model identity, no new provider, no alias row. `gemma-4-31B-it` is
already published (through `prv_sambanova`, the identity's only provider today —
verified on production: depth = **1**, SambaNova only). What changes is that the
identity gains a **second** provider: depth 1 → 2. `/v1/models` output is
unchanged, because the slug set does not move.

Every JOIN precondition was checked against production before the row was
written, and all three resolve:

```
model_ok=1   lower(slug)='gemma-4-31b-it' and status='active'
prov_ok=1    prv_googleai enabled and status='active' and tier='commercial'
conn_ok=1    con_prv_googleai-default enabled and provider_id='prv_googleai'
```

## The migration never invents a row

The insert is a `SELECT ... FROM` join, not a `VALUES` list, so a renamed model,
a retired provider or a removed connection yields **zero rows** rather than a
dangling mapping. The guard is pinned by
`TestMergeDepthMigrationSkipsUnservableIdentity`, which stages the identity three
ways — provider disabled, connection disabled, model inactive — and asserts the
migration publishes **0** rows in each. A migration that inserted
unconditionally would pass the happy path and fail this one.

Idempotence is pinned too: the insert is keyed on
`provider_model_target_idx (model_id, provider_id, coalesce(connection_id,''))`
via `ON CONFLICT DO NOTHING`, and the audit row on `pm_id`. A replay leaves
exactly one row and one audit entry — asserted, not assumed.

## The rollback reads the audit table, not a hardcoded id

`provider_model_merge_audit` records *which* rows the migration created
(`prev_*` NULL) or repointed (`prev_*` set), so the undo can restore a row an
operator has since repointed and delete only the row the migration itself made.
That is the difference between an undo and a purge, and
`TestMergeDepthRollbackRestoresCatalogue` pins it: the migration publishes its
row, the rollback removes it, and a pre-existing mapping on a second connection
of the same provider **survives**. Running the rollback twice is a no-op.

## Five real bugs found by running the tests

The test file had never been green. Every one of these was a genuine defect in
the test-harness or fixture, not a flake:

**1. `model.input_price` / `output_price` are NOT NULL with no default.** The
fixture inserted `(id, provider_id, name, slug, context, status, capabilities)`
and died on `SQLSTATE 23502`. Verified against production *and* the test DB —
both `is_nullable=NO`, `column_default=NULL` — so the fixture was wrong, not the
schema. Every other store test already supplies a price.

**2. The second provider had no credential,** so the depth assertion failed
before the migration ran (`before = 0, want 1`). The depth predicate requires a
live credential *per connection*; a provider without one is invisible to it. The
fixture now seeds `cred_second_fixture` and the assertion is meaningful again.

**3. The rollback test's "pre-existing" row occupied the migration's own unique
target** — same model, same provider, `connection_id` NULL, which is exactly what
`coalesce(connection_id,'')` folds onto. `ON CONFLICT DO NOTHING` therefore made
the migration publish nothing (`published rows = 0, want 1`), and the test failed
for a reason it is not about. The pre-existing mapping now sits on a **second
connection** of the same provider, which satisfies the FK and leaves the unique
target free.

**4. A dangling `connection_id` aborted the transaction.** The original fixture's
first insert named a connection that does not exist; the FK rejected it and — the
real damage — put the transaction in `25P02`, so *every later statement in the
test* failed with `current transaction is aborted` and the actual cause was three
stack frames away. The row is now inserted with a resolvable connection.

**5. The rollback path was one directory short.** `../../../ops/rollback/...`
from `internal/store` lands on `backend/`, not the repo root; it needs four.
The test could never have passed and the failure message (`no such file or
directory`) reads as a missing artifact rather than a wrong relative path.

## The harness was writing into the shared catalogue

The most consequential bug, and the one that made three failures look like
broken guards.

`mergeDepthSchema` layers an overlay schema over `public` with
`SET LOCAL search_path`, on the assumption that the test runs inside its own
transaction. It does not, if the migration carries its own `BEGIN`/`COMMIT`:
a nested `BEGIN` is a no-op in PostgreSQL, so the migration's `COMMIT` ends the
*harness's* transaction. Two consequences:

- `SET LOCAL` is reverted by that `COMMIT`, so the setting is now applied with
  plain `SET` — otherwise the post-migration assertions silently fall back to
  `public` and read the wrong catalogue.
- Anything the migration writes must already have a home in the overlay. Without
  it the writes land in **`public` and stay there**. Proven, not theorised: after
  one run, the shared `fudrouter_test.provider_model` carried
  `pmdl_merge_googleai_gemma_4_31b` and a matching audit row. The committed row
  then makes `ON CONFLICT DO NOTHING` skip, so *every* negative case reported
  `1 row` and read as a migration that ignores its own guard.

Two independent fixes, because either alone leaves the failure one edit away:

1. **The migration carries no `BEGIN`/`COMMIT`** — matching 0026 and 0028, the
   identity migrations it builds on. The runner applies each file with
   `ON_ERROR_STOP`; apply by hand with `psql -1 -f` when a single-transaction
   apply is wanted.
2. **The overlay clones the fixture tables** (`create table ... (like public.x
   including all)`) so the migration has somewhere legitimate to write, and the
   clone carries the indexes `ON CONFLICT` needs. `including all` copies no
   foreign keys, which is what lets a fixture name a connection that does not
   exist.

The clone alone would make the leak invisible; the missing `COMMIT` alone would
still let a future contributor reintroduce it. `assertNoLeak` is the control for
both: it opens a *separate* connection — which only sees committed data — and
fails if any fixture row is visible there. **The control was proven to fail**, by
deleting the clone loop and re-adding `COMMIT`: `2 fixture rows are visible on a
separate connection`. Restored, and the suite is green with `public` clean.

The leaked rows in `public` were removed and the seven stray
`merge_depth_test_*` schemas from earlier runs dropped; the test now leaves both
at zero.

## Verification

```
go test ./internal/store/ -run TestMergeDepth -v     3/3 PASS
go test ./internal/store/ -count=1                   ok (46s, whole package)
go build ./...                                       BUILD_OK
go vet ./internal/store/ ./internal/proxy/            clean
production pollution check
  public.provider_model row   = 0
  public audit rows           = 0
  stray merge_depth_test_*    = 0
```

Applied to production, and the apply was verified by reading back:

```
provider_model           621 -> 622 rows
  pmdl_merge_googleai_gemma_4_31b  prv_googleai  models/gemma-4-31b-it  available
gemma-4-31B-it rows on canonical 6d0d8238...   1 -> 2
replay of the migration                        no-op (still 622, audit still 1)
schema_migration                               0030_merge_depth_publish recorded
```

The one test that does not pass is `internal/proxy`'s
`TestLoadLedgerSurvivesPoolOversubscription`, a 128-worker load test that hits a
real pool. It is untouched by this change (the diff is additive files only, none
under `internal/proxy`) and the package has concurrent uncommitted edits from
other cards in the same working tree, so it is reported here rather than fixed.

## Not done

- **Canonicalization of the 38 alias-pointing `provider_model` rows is not
  shipped.** It is the larger lever (depth ≥2: 43 → 51 per the operator's
  measurement) and it is deliberately a separate card: repointing a
  `provider_model.model_id` also moves the `pricing_rule` that is keyed on that
  row (115 of 308 rules are keyed on an alias model row), so it needs its own
  pricing decision and its own rollback. Mixing it into a "publish one proven
  pair" migration would make both changes unauditable.
- **Depth is 1 → 2 for one identity, not a fleet-wide fix.** 114 identities are
  still single-provider. This is one pair, chosen because it is the one the probe
  could prove; the rest need their own probe runs, and several will land in the
  `KEY` (dead credential, live mapping) state rather than `DEAD`.
- **The pair's depth is not durable.** It depends on SambaNova's single
  credential, which flaps. See the time-variance note at the top: the published
  mapping is permanent, the depth it buys is not.
- **`gemma-4-31B-it` has a case-sensitive slug** (`B` uppercase). The migration
  matches with `lower(m.slug)`, so it is insensitive here, but a case-mismatch
  between a routing request and the published slug is a live footgun for anything
  that matches exactly.

## Verdict per scoped provider

Task item 4 was "activate a non-active provider only if its credentials still
work; if dead, record it and leave it inactive". Every scoped provider, with the
evidence that decided it:

| provider | creds | upstream `/models` | published | verdict |
|---|---|---|---|---|
| `prv_googleai` | 21 | 60 (HTTP 200) | 8 | **1 new pair published.** `models/gemma-4-31b-it` → 200 with usage. `models/gemini-3.7-flash` → **503 on 3 keys**, so it is left unpublished: a 503 proves neither that the mapping resolves nor that it does not. |
| `prv_dahl` | 20,290 | 3 | 3 | **Saturated by name.** All 3 upstream ids already match exact and already point at other providers' rows. Its 20,290 credentials buy *reliability within* 3 identities, not new pairs — the pool:surface ratio (6,800:1) is not a depth opportunity. |
| `prv_tokenjuice` | 7,538 | 1 | 1 | **Saturated by name.** One upstream id, already published. Its contribution is the 120 s hang (16 attempts ≥100 s in 2 h, all `PROVIDER_UNAVAILABLE`), which is card `t_e6997af4` and the reason `deepseek-v4.1-flash` has p95 = 120 s. |
| `prv_mistral` | 10,293 | 55 | 54 | **Saturated by name.** `new=0`. |
| `prv_tokenharbor` | 9,107 | 77 | 78 | **Saturated by name.** `new=0`, 29 ids matched through aliases. |
| `prv_tt` | 649 | 22 | 14 | **Nothing probe-provable.** 13 of its 14 published rows are `status='unavailable'` (correctly excluded from depth). The 8 unpublished ids either do not resolve onto an active chat-capable canonical or failed the probe; the 3 probed premium ids (`MiMo-V2.6-Pro`, `gpt-5.6-sol`, `claude-opus-5`) all came back `KEY`/`DEAD`. Left as is. |
| `freeai` | 4,281 (4,350 live) | no answer | 45 | **Dead at the source, not a gap here.** 43 attempts / 0 success in 24 h = 100 % 429. It has no `connection` row, so `merge-depth-plan.mjs` correctly errors "no connection" instead of inventing a plan. |
| `prv_9316bf5d…` (grok), `prv_unikey`, `prv_excelnt` | 663 / 123 / 493 | — | 0 | **Left inactive.** Non-active providers whose credentials were never proven against a live endpoint in this card; activating them would have required a probe this card did not run, and the card's rule is "prove one request or leave it off". |

The conclusion the numbers force: **merge-by-name is exhausted across every
provider in scope.** Five of the eight are saturated (upstream ids already
published); one yields a single provable pair; one is dead at the source; three
stay inactive. No provider in scope can be made deeper by matching names — the
remaining levers are identity canonicalization (a separate card) and parking the
120 s envelope (card `t_e6997af4`).
