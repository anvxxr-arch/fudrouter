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

## Fixed

- **`tokenAt()` now reads both shapes** — the flat spec §4 account fields and the
  pooled `accounts[]` form, with a pooled entry winning when the index exists.
- **`credentialLabels()` labels a flat account by its email** instead of showing
  "single key" for every one of them.
- **`isExpiredOAuth()` added**, and `credential_validation` no longer records
  `auth_failed` for an OAuth account whose access token is past `expired`: the
  data plane refreshes such an account from `refresh_token` on demand, so a 401
  there is the stale token, not a dead account. Those rows are recorded as
  `unknown` instead — a false `auth_failed` would park a live credential.
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

## Also fixed: a flaky suite

`jobs.test.ts` cleans up with `delete from job where id like 'job\_%'`, which is
the id shape the scheduler also uses, and it claims jobs by type — the same types
the scheduler enqueues. Run in parallel against one `fudrouter_test` database the
two race, so a pass depended on scheduling order. Adding a test file shifted the
timing and made it fail. The `server` project now runs with
`fileParallelism: false`; it costs ~13s and three consecutive full runs are green.
