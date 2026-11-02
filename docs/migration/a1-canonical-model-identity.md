# A1 — canonical routing identity and virtual coverage

Verified on `feat/id` against the orchestrator's catalogue copy at
`127.0.0.1:55432/fr_id`. The starting commit was
`06fa2c9870e187a3b1dca1c9f32c861387d71644`.

## Result

- `fudrouter/auto`: **154/154 targets have candidates, 100%, one candidate query**.
- The fixture-backed coverage gate also passed: **195/195**, one query.
- Live provider-prefixed and case-variant names resolve to the routing identity;
  its candidates include the live mappings from every member of that identity.
- Original model rows, published slugs, upstream ids, provider-model ids, source
  capabilities and source price histories are retained. Candidate map keys use the
  requested identity; each candidate keeps its original billing model id.
- Account aliases retain their precedence. All seven virtual names are tested
  against canonical capability claims and provider-model overrides, including
  unknown claims and explicit false vetoes.
- An old live prefixed input was exercised through the real chat handler and a
  local HTTP upstream: HTTP 200, original upstream id, original requested spelling
  in `request_log`, and the original published slug.

The initial branch already contained 0026 and the virtual capability filter, but
its alias fallback ran only after a live literal missed. It did not join the
providers of live duplicate rows. The added identity tests failed on that code;
resolution and both candidate entry points now share the identity fan-out.

## Migration and compatibility

`model_alias` already exists for account-scoped names and ordered
`model_alias_target` lists (`0006_platform_schema.sql:249`, flattened by 0019).
Replacing it with a text-alias primary key would break that existing feature and
its foreign keys. The identity layer therefore uses **model_slug_alias**, with
`alias text primary key` and `canonical_model_id references model(id)`.

0028 is the next free migration after the already-present 0026. Its forward
backfill, and the matching fresh-install backfill in 0026, recognise case variants
and actual provider namespaces whose entire remaining plain slug already exists.
InferHub's nested prefixes are scoped to InferHub. Unknown namespaces are not
collapsed; upstream ids, date suffixes and `:free` spellings are not rewritten.
Existing explicit bindings are retained on conflict.

Tests execute both migration files against a newly created, transactionally
rolled-back alias schema, then replay them. The forward migration is also run
repeatedly with a newly seeded alias in the ordinary test schema, comparing the
complete alias-to-id map rather than a row count that an empty migration could
satisfy. No production migration or service operation was performed.

## Depth distribution

The denominator is routable active chat identities with at least one provider
satisfying the task's exact predicate. It is not all 570 stored model rows.

| Phase | Total | Depth 1 | Depth 2 | Depth 3+ |
| --- | ---: | ---: | ---: | ---: |
| Before, stored model ids | 159 | 152 (95.60%) | 6 (3.77%) | 1 (0.63%) |
| After, routing identities | 154 | 145 (94.16%) | 5 (3.25%) | 4 (2.60%) |

`ops/verify/model-depth.sql` computes both phases from the same snapshot. The
eligibility predicate is unchanged between phases; only the grouping id changes
from `model.id` to its active alias target when one exists. Providers are counted
DISTINCT, not credentials or connections. In particular, the metric adds no
provider publication/tier gate and no legacy-blob substitute:

```sql
model.status = 'active'
and capabilities->>'chat' is distinct from 'false'
and provider_model.enabled
and provider_model.status not in ('disabled','unavailable')
and connection.enabled
and connection.health_status is distinct from 'unhealthy'
and exists (
    select 1 from credential
    where credential.connection_id = connection.id
      and credential.status not in ('disabled','invalid')
      and (credential.cooldown_until is null or credential.cooldown_until <= now())
)
```

The complete raw eligible model/id/slug/depth snapshot remained identical before
and after the test runs. The original catalogue sizes were read back unchanged:
26 providers, 570 models, 523 provider-model rows and 74,242 credentials.
The improvement is logical provider union, not deletion or re-keying of rows.
Most identities still have only one usable provider; disabled/unavailable mappings
are not counted as extra depth.

## Writer discovery correction

`ops/catalog-discover.mjs` is read-only, not a slug writer. The verified prefix
writers include `ops/seed-models.mjs:60` (`PREFIX/upstream`) and
`ops/onboard-tokenjuice.mjs:192` (`tokenjuice/deepseek-v4.1-flash`).
`ops/onboard-excelnt.mjs:140` retains the upstream id's original case.
No onboarder was executed and no plaintext upstream credentials were printed.

## Exact commands and observed outcomes

All Go commands ran from `/home/dwizzy/fr-id/backend/go`, with the validated
isolated `DATABASE_URL`, `GOTOOLCHAIN=auto` (Go 1.26.10), and no inherited
credentials master key or Valkey URL. The normal full suite was not serialised or
filtered. Repository checks/builds ran from `/home/dwizzy/fr-id`.

1. `go test ./... -count=1`
   - Initial run: FAIL in store and proxy. The whole-catalogue fan-out growth
     ratio failed (184 -> 384 despite fixture growth); virtual rewrite selected
     remote catalogue candidates and returned 503; the load-ledger assertion
     also failed. No SQLSTATE 53300 was reported.
   - After fixes: PASS, 14 packages with tests.
   - Final run on the restored final code: PASS, 14 packages, zero package
     failures (proxy 107.989s, store 106.086s).

2. `go test ./internal/store -run 'Test(CanonicalIdentityUnitesLiveProviderMappings|ModelSlugAliasBackfillAndRouting|ModelSlugAliasMigrationIsIdempotent|VirtualCapabilityTargetsMatchCandidates)$' -count=1 -v`
   - Before the runtime fix: FAIL. Both live-old-name identity assertions failed.
     The new idempotence fixture also hit SQLSTATE 23502 because it omitted
     non-null price fields; those fixture fields were fixed explicitly.
     The virtual capability subtests passed on the already-filtered starting code.

3. `go test ./internal/store -run 'Test(CanonicalIdentity.*|Model.*|Virtual.*|Candidates.*|LiteralResolveIsOneQuery|ResolveModelAliasIsOneQuery)$' -count=1 -v`
   - PASS (64.646s). Live identity fan-out, fresh migration creation/replay,
     forward backfill idempotence, alias precedence, all virtual capability
     cases, single/batch parity and query-count gates passed. Coverage 195/195.

4. `go test ./internal/proxy -run 'Test(OldProviderSlugRoutesWithoutRenaming|VirtualRequestRewritesUpstreamModel|LoadLedgerSurvivesPoolOversubscription)$' -count=1 -v`
   - Old-name compatibility and virtual rewrite: PASS.
   - Isolated load test: FAIL, 1,987 HTTP 200 and 13 HTTP 429 responses out of
     2,000 requests. Limit/billing code and the load test were not changed for
     this workstream. Both subsequent unfiltered full-suite runs passed it.

5. `go test ./internal/store -run '^TestVirtualCatalogueCoverage$' -count=1 -v`
   - PASS: real catalogue, no seeded rows needed, 154/154 targets, one query.

6. `go test ./internal/store -run '^TestVirtualFanOutStillCoversEveryModel$' -count=1 -v`
   - Intentional mutation test: replacing the virtual's required caps with nil
     produced FAIL, 195/233 targets returned candidates, still one query.
     This proves the coverage gate catches the 38 dead ends. The mutation was
     restored immediately and is not in the final code.

7. `go test ./internal/store ./internal/proxy -run 'Test(CanonicalIdentityUnitesLiveProviderMappings|ModelSlugAliasBackfillAndRouting|ModelSlugAliasMigrationIsIdempotent|ModelIdentityMigrationsCreateAndReplay|VirtualFanOutStillCoversEveryModel|OldProviderSlugRoutesWithoutRenaming|VirtualRequestRewritesUpstreamModel)$' -count=1 -race`
   - PASS after restoring the mutation: both packages (store 20.078s,
     proxy 17.839s). This is targeted race coverage, not a claim of a full race run.

Additional verification:

- `go vet ./...` and `go build ./...`: PASS, repeated with checked exit status.
- `git diff --check`: PASS.
- `psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -f ../../ops/verify/model-depth.sql`:
  PASS; the depth table above is its actual JSON output.
- `npm run check`: initially failed because local dependencies were absent.
- `NODE_ENV=development npm_config_cache="$TMPDIR/fr-id-npm-cache" npm ci`:
  PASS; local dependencies installed from the unchanged lockfile. The install
  reported four dependency audit findings (two moderate, two high); no audit fix
  or dependency version change was made.
- `npm run check` after install: web/platform typechecks and contract staleness
  checks PASS; overall FAIL on the existing structure gate's eight Go command
  directories: blobshape, cfpprobe, credcanary, credshape, limprobe, poolcount,
  poolrebuild and rotprobe. Each is tracked in the starting HEAD. No command or
  layout allowlist was changed in this workstream.
- `npm run build`: PASS (Vite 6.4.4, 94 modules, 3.97s).

No PM2, Docker service operation, deploy, restart, cron, subagent, global Hermes
configuration change, or production database operation was performed.