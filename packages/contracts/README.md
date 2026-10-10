# @fudrouter/contracts

The HTTP surface of both planes as a **verifiable artefact**, plus the OpenAPI
documents derived from it.

This package exists because a modular-monorepo migration moves files and rewires
imports, and the one thing that must not move is the surface clients depend on.
Before it, the surface was an emergent property of two codebases: the Go plane
pinned its table with a test (`internal/proxy/surface_test.go`) and the Express
plane pinned nothing across 180+ registrations.

## Contents

| file | what it is |
|---|---|
| `routes.json` | **generated** — the route lock for both planes + a sha256 per source file |
| `openapi/inference.yaml` | **hand-written** — the Go data plane, 7 routes |
| `openapi/management.yaml` | **generated** — the Express plane, 187 operations |
| `scripts/extract-routes.mjs` | extracts the live surface into `routes.json` |
| `scripts/gen-openapi-management.mjs` | derives `management.yaml` from `routes.json` |
| `test/surface.test.mjs` | the gate: fails on a silent route change |

## Commands

```bash
npm run extract -w @fudrouter/contracts   # regenerate routes.json
npm run gen     -w @fudrouter/contracts   # regenerate management.yaml
npm run check   -w @fudrouter/contracts   # verify both are current (exit 1 if not)
npm test        -w @fudrouter/contracts   # the regression gate
```

`npm run check` is also picked up by the root `npm run check` (it uses
`--workspaces --if-present`), which `typecheck.yml` runs — so the lock is
enforced in two places, and `ci.yml`'s `contracts` job names the failure
explicitly.

## Current counts

- inference: **7** routes (6 method-scoped + the methodless `/v1/` catch-all)
- management: **187** operations — 85 GET, 101 POST, 1 `all`
- middleware: **14** entries

## Design rules

1. **Never guess.** The extractor **exits 1** on a template path it cannot
   resolve instead of emitting a partial route. Ambiguity is a bug report, not a
   silent default.
2. **`app.use('/x', …)` is not a path prefix here.** Every `app.use('/api/…')` in
   `index.mjs` is rate-limiting or middleware, while the routers register full
   paths themselves. Treating the mounts as prefixes would have produced
   `/api/admin/api/admin/…` paths. Mounts are recorded under `middleware` so the
   distinction stays visible.
3. **Bodies are modelled or explicitly not.** `inference.yaml` documents real
   schemas because they were read out of the Go source. `management.yaml` marks
   every operation `x-body-schema: unmodelled` and carries `x-source: {file,
   line}` instead — a fabricated schema for a Drizzle result object would look
   authoritative and be wrong.
4. **A new inference route fails the build** until it is added to
   `INFERENCE_PATH_MAP` in `test/surface.test.mjs`, i.e. until someone decides
   how it is documented.

## Public vs authenticated

`gen-openapi-management.mjs` does not guess which routes are public. It reads
`index.mjs` and treats a prefix as public **iff** it is mounted with
`_publicRead`, the limiter keyed by client IP (`_ipKey`). Everything else is
keyed on the authenticated identity (`_limitKey`).

Current public prefixes:

`/api/changelog`, `/api/docs`, `/api/metrics`, `/api/models`, `/api/palette`,
`/api/pricing`, `/api/providers`, `/api/status`

## The negative test that makes the gate real

A gate nobody has seen fail is not a gate. Removing one route from the lock makes
**2 of the 8** tests go red; restoring it makes all 8 green again.
