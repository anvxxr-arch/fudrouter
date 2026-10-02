# Credential validation was probing with no Authorization header

`tokenAt()` in `apps/web/src/lib/server/provider-credentials.ts` read the token
out of `accounts[]` only. But a credential row is **one account stored flat** at
the top level — `{email,access_token,refresh_token,id_token,expired}` — because
spec §4 defines one account = one credential row, and that flat form is exactly
what the data plane writes (`pool.go` `marshalAccount`) and reads back
(`targets.go` `accountFromSecret`). `tokenAt()` therefore returned the empty
string for **all 12,044 rows**, and `headersFor()` — which only emits an
`Authorization` header when the token is non-empty — sent nothing.

So every upstream call the console made on a credential's behalf was
**unauthenticated**: the `credential_validation` probe, the `provider_model_sync`
catalog fetch, the admin provider sandbox, and the provider page's test button.
All four call sites go through the same two helpers.

## What that did to the pool's status

The probe maps an upstream response onto `credential.status`, so the verdicts
were meaningless:

- `auth_failed` meant *"this provider's `/models` requires auth"* — 3,901 rows,
  none of them a statement about the credential.
- `healthy` meant *"this provider serves `/models` publicly"* — 264 rows. Verified
  directly: `openrouter.ai/api/v1/models` returns **200 for a valid key, an
  invalid key, and no key at all**.

Reading that table suggested the credential pool was ~99% dead. It is not. The
same credential, probed with the header the data plane would send, answers
**200 with a full catalog**.

## The blast radius, measured

Four call sites broke, but they did not all break equally, and the severity was
not where it looked. Checked against the router's own predicate
(`store/catalog.go` `usableCredentials`):

```sql
where connection_id = $1
  and status not in ('disabled', 'invalid')
  and (cooldown_until is null or cooldown_until <= now())
```

- **Routing: one real casualty.** `auth_failed` is **not** an exclusion, so the
  3,901 rows falsely labelled that way were never withheld — and the probe does
  not write `cooldown_until` at all (only the data plane's `parkCredential`, on
  a real 401/429 during a live request, does). The exclusion predicate is
  `disabled`/`invalid`, and the probe wrote **`invalid` to 10 rows** (a 404 from
  an unauthenticated `googleai` probe). Those 10 credentials *were* genuinely
  withheld from routing. The corrected probe plus the status reset cleared them;
  `select count(*) from credential where status in ('disabled','invalid')` is
  now 0.
- **The catalog sync's diff report was garbage, but no rows were lost.**
  `provider_model_sync` is report-only by contract — it computes the delta and
  writes a `system_event`, never an insert. Comparing its own events across the
  fix (worker restarted 07:20, commit 07:37:55) shows the fetch going from
  unauthenticated to authenticated: at 06:55 `tokenharbor`, `gonka24`, `unikey`,
  `googleai` and `inferhub` all reported `catalogSize: 0`, and from 07:22 they
  reported 64, 2, 44, 61 and 272. `kiraai` (81) and `openrouter` (464) were
  unchanged across both — the two providers whose `/models` is public, which is
  the same fact that makes their 2xx uninformative. A `catalogSize: 0` also
  makes every existing model look *removed*, so an operator reading the diff saw
  a false "everything disappeared" signal.
- **The console's health report** was the loud symptom: the table read as ~99%
  dead.
- **The admin "test provider" button** sent no auth, so testing a working
  provider reported failure.

The catalog gap that remains (`tokenharbor` 1 row stored against 64 advertised)
is **not** this bug: the sync never adds rows by design, so closing it is the
admin publish flow, not a repair.

## Fixed

- **`tokenAt()` now reads both shapes** — the flat spec §4 account fields and the
  pooled `accounts[]` form, with a pooled entry winning when the index exists.
- **`credentialLabels()` labels a flat account by its email** instead of showing
  "single key" for every one of them.
- **`isExpiredOAuth()` added**, and `credential_validation` no longer records
  `auth_failed` for an OAuth account whose access token is past `expired`: the
  data plane refreshes such an account from `refresh_token` on demand, so a 401
  there is the stale token, not a dead account. Those rows are recorded as
  `unknown` instead: a probe cannot judge a credential it is unable to
  authenticate, and `auth_failed` would assert a failure it has no evidence for.
- **A 2xx no longer counts as `healthy` when it proves nothing.** The connection
  is re-probed anonymously, memoised per connection per run so it costs one
  request per connection rather than one per credential; if `/models` answers
  without auth, no 2xx from that connection is evidence and the verdict is
  `unknown`.

## Verified

- **16 new tests** in `provider-credentials.test.ts`. Reverting `tokenAt` to the
  old line turns two of them red, so the regression is actually caught.
- Live, on the real table: the same credentials that read `auth_failed` now read
  `healthy` — `unikey` 1/124 → **124/124**, `googleai` 1/11 → **11/11**,
  `inferhub` 0/2 → **2/2**, `tokenharbor` 250/250 probed all healthy, `gonka24`
  500/500 probed all healthy.
- `mingles` stays `auth_failed` with a correct header ("Invalid API key", where
  the unauthenticated probe had said "Missing API key") — the fix distinguishes a
  dead pool from a broken probe rather than flipping everything green.
- `openrouter` and `kiraai` moved from a false `healthy` to `unknown`, which is
  the honest answer for a provider whose `/models` is public.
- The 4,434 verdicts written by the buggy probe were reset to the neutral state
  so the corrected probe revalidates them instead of the cursor skipping them.
- 890 tests pass across 59 files; `svelte-check` reports 0 errors.
- **The whole table was decrypted and classified** (12,044 rows, 0 decrypt
  failures): 12,035 are `flat oauth` and 9 are `flat api_key`. There are **zero**
  `accounts[]` pooled blobs, and **zero** rows without a usable token — so the
  flat shape is not merely the common case, it is the only case, and the fix's
  premise holds for every row.

## Revalidation cadence

Resetting the statuses does not re-probe everything at once: the scheduler runs
`credential_validation` **hourly, one job per enabled connection, capped at
`CREDENTIAL_VALIDATION_BATCH` (250) per run**, with the cursor
`order by last_used_at asc nulls first`. That cap is deliberate — 12k upstream
probes in one job is an outage, not a validation. The practical consequence is
that the tail is bounded by the largest connection, not by the table:
`gonka24` holds 10,003 credentials, so its 8,753 unprobed rows take **~36 hours**
to work through, while every other connection finishes within two. `unknown` is
not an exclusion, so nothing is withheld from routing while it waits.

## Also fixed: a flaky suite

`jobs.test.ts` cleans up with `delete from job where id like 'job\_%'`, which is
the id shape the scheduler also uses, and it claims jobs by type — the same types
the scheduler enqueues. Run in parallel against one `fudrouter_test` database the
two race, so a pass depended on scheduling order. Adding a test file shifted the
timing and made it fail. The `server` project now runs with
`fileParallelism: false`; it costs ~13s and three consecutive full runs are green.
