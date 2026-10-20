# A client disconnect inside the compare relay's fetch window leaked a minted run key

`POST /api/playground/compare` (`apps/web/server/playground.mjs:464`) mints one
5-minute `sk-ar-` run key per model (`playground.mjs:511`, `playground.mjs:324`),
runs the upstream calls concurrently, and reclaims every key in `settle()`'s
`finally` (`playground.mjs:665-669`). The reclaim is the whole safety property: a
key that outlives its client is a live credential nobody is watching, valid until
its TTL expires. This entry records the fix for a window in which the reclaim was
never reached — and the first fix, which did not work, because the reason it failed
is the part worth keeping.

## The bug

`run.upstream` is assigned inside async `settle()` **after** `await fetch(...)`
resolves (`playground.mjs:576`), but the `res.on('close')` disconnect handler reads
`run.upstream?.body?.cancel()` (`playground.mjs:540`). A close landing in that
window finds `run.upstream` still `undefined`, so `body.cancel()` is a silent no-op
and the run depends on `controller.abort()` alone to error a body reader that may
not exist yet.

When it does not, `reader.read()` never rejects, `settle()` never reaches its
`finally`, and the minted key survives until its 5-minute TTL instead of being
reclaimed. Nothing logs, nothing errors, and the response has already been written
— the only observable is a row in `api_key` that outlived its run.

## Why the first attempt failed

The first fix added three `if (run.controller.signal.aborted)` guards inside
`settle()` — after the fetch resolves (`playground.mjs:583-586`), at the top of the
`!upstream.ok` branch (`playground.mjs:588-591`), and before
`upstream.body.getReader()` (`playground.mjs:623-626`). Each one cancels the body
and returns into the `finally` that reclaims. The reasoning was sound: if the abort
propagated, one of the three would catch it.

It did not work. The decisive evidence was a failure reading "**2 leaked**" — both
runs, not one. If `controller.abort()` had propagated, at least one guard would
have caught it, because all three check that flag. Both leaking means the flag was
false in both runs: the close handler either never fired, or fired after the
assertion's 600ms window (`playground-compare.test.mjs:242`). The guards checked a
signal that was not set.

The lesson: a guard that reads a signal is only as good as the guarantee that the
signal was set. `res.on('close')` is a best-effort notification, not a promise —
Node emits it when the socket tears down, and nothing in the relay's control makes
that happen before an arbitrary await resolves. An invariant as load-bearing as
"every minted key is reclaimed" cannot be conditional on a notification the
platform does not guarantee to deliver in time. It has to hold without depending on
any signal at all.

## The fix

The close handler now reclaims every minted run key directly, in addition to the
existing abort + `body.cancel()` loop (`playground.mjs:542-549`):

```js
for (const run of runs) void run.reclaim().catch(() => undefined);
```

The reclaim is idempotent — `pgMintRunKey`'s `reclaim` carries a `done` flag
(`playground.mjs:305-309`) so the disable-then-delete runs exactly once — which is
what makes calling it from two places safe. When the close handler has already
reclaimed, `settle()`'s `finally` (`playground.mjs:667`) is a no-op; when
`settle()` wins the race, the close handler's call is the no-op. Neither can
double-delete or double-audit.

This is structural rather than statistical: the reclaim no longer depends on
`settle()` reaching its `finally`, so no hang inside `settle()` — a `reader.read()`
that never resolves, a `pgFetchRunMetrics` poll that never returns — can leak a
key. The invariant holds on the disconnect path regardless of what the async body
is doing.

The abort guards remain in `settle()` and are worth keeping: the ones before
`getReader()` (`playground.mjs:623-626`) and before the ledger poll
(`playground.mjs:647`, `:654`) stop a wasted `pgFetchRunMetrics` poll (5 × 150ms)
and a reader creation on the disconnect path. They are an optimisation on the
disconnect path, not what closes the leak.

## The single-model relay was not touched

`/api/playground/stream`'s `upstream` is a `let` assigned before `writeHead`
(`playground.mjs:367-373`, `playground.mjs:403`), so by the time a `res.on('close')`
can fire the variable is already set and `body.cancel()` has something to cancel.
There is no window there, and adding a guard would be noise.

## The gate is probabilistic, and the measurement does not prove the fix

The failure is intermittent — a race between the close event and the fetch
resolution, so it reproduces only when the disconnect lands inside a window that is
microseconds wide on a fast upstream. The gate is
`apps/web/tests/integration/playground-compare.test.mjs`'s "a client disconnect
mid-run aborts the upstream calls and reclaims every key"
(`playground-compare.test.mjs:216`), which counts `api_key` rows where
`policy->>'playground' = 'true'` before and after and asserts `after <= before`
(`playground-compare.test.mjs:219`, `:248-249`). The stub upstream holds both
models' streams open (`playground-compare.test.mjs:210-214`) so the only way the
keys get reclaimed is the disconnect path.

The honest numbers across the three states:

| state | runs | failures |
|---|---|---|
| before any fix | ~69 | ~6 |
| three abort guards in `settle()` | 13 | ~2 |
| close-handler reclaim | 10 | 0 |
| mutation: new loop commented out, guards left in | 10 | 0 |

The middle row is the one that mattered: ~2 failures in 13 runs is no meaningful
improvement over ~6 in ~69, and that flatness is what exposed the wrong hypothesis.
The bottom row is the honest limit of this measurement — the mutation sample did
not reproduce the race, so the runs do not prove the fix closes it. A race gate is
probabilistic; a single green run is not proof, and the assertion is the invariant,
not the run count. The argument for the fix is the structural one above, not these
counts.

The `<=` rather than `===` is deliberate — a decrease is a leftover from an earlier
run being reclaimed inside the window, which is cleanup, not a leak, and asserting
exact equality made the gate fail on a green run
(`playground-compare.test.mjs:244-247`).

## Verified

- `node --test apps/web/tests/integration/playground-compare.test.mjs` → green,
  10 consecutive runs.
- `node --test apps/web/tests/integration/playground-stream.test.mjs` → green
  (single-model regression check; the untouched relay still behaves).
- `NODE_ENV=development npm run check` → exit 0.
- Vite build → exit 0.
- Full `apps/web` suite → **127 tests, 122 pass, 0 fail, 5 skipped**.
