# Data plane — endpoint surface

**Date:** 2026-09-25
**Status:** Draft — awaiting review
**Scope:** `services/router` (Go data plane), the `/v1/*` public surface
**Supersedes:** nothing. Extends `2026-09-21-s0-foundation-design.md` §2 (which
defined exactly one hot path, `POST /v1/chat/completions`).
**Evidence:** every status below was measured on an isolated router instance
(the production binary, scratch DB, mock upstream) plus live probes through
`https://ai.karepmuwes.my.id`. Nothing in this document is inferred from reading
code alone.

---

## 1. Why this document exists

`fudrouter` is a commercial AI router. Customers point an [OI]-compatible client
at a base URL and expect the [OI] surface. Today the router registers **four**
routes and lets a catch-all absorb everything else:

```go
// services/router/main.go:59-62
mux.Handle("GET /health",              newHealthHandler())
mux.Handle("GET /v1/models",           http.HandlerFunc(p.ServeModels))
mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))
mux.Handle("/v1/",                     http.HandlerFunc(p.ServeGeneric))  // catch-all
```

Because `/v1/` matches every path, a client asking for an endpoint we do not
implement gets **`401 invalid api key`** — not `404`. That makes the surface
*look* far larger than it is, and it is the single most misleading thing about
the API. This spec records what actually works, what only appears to, and what
it would take to close the gap.

---

## 2. Current surface (what is really implemented)

| Method | Path | Handler | Quality |
|---|---|---|---|
| `GET` | `/health` | `newHealthHandler` | Liveness only — does **not** check the DB (see audit H5) |
| `GET` | `/v1/models` | `ServeModels` | **Native.** Public by design, no auth. Returns the published catalog. |
| `POST` | `/v1/chat/completions` | `ServeCompletions` | **Native and complete.** Auth, limits, `stream_options.include_usage` injection, ≤3-account failover, SSE, billing on every outcome. |
| any | `/v1/*` | `ServeGeneric` | **Generic passthrough.** Authenticates, enforces limits, fails over, bills — but forwards the request incorrectly (see §4). |

That is the whole surface. Everything else is the catch-all.

---

## 3. Requested surface vs. reality

Measured against an isolated instance serving a mock provider. `model` column =
whether the endpoint requires a JSON body carrying `model`.

| # | Method | Endpoint | Status | Observed | Note |
|---|---|---|---|---|---|
| 1 | POST | `/v1/responses` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /responses` | Works, but only because the client happens to send `model`. No `stream_options` injection → a streamed `/v1/responses` is likely **unbilled**. |
| 2 | POST | `/v1/chat/completions` | ✅ **native** | full hot path | Reference implementation. |
| 3 | POST | `/v1/completions` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /completions` | Same `model` dependency. |
| 4 | GET | `/v1/models` | ✅ **native** | `200 {"data":[…]}` | Public, unauthenticated by design. |
| 5 | GET | `/v1/models/{model}` | ❌ **broken** | `400 invalid JSON body` | GET is parsed as a JSON body. |
| 6 | POST | `/v1/embeddings` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /embeddings` | Works today; billed (verified: a `request_log` row is written). |
| 7 | POST | `/v1/moderations` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /moderations` | Same as embeddings. |
| 8 | POST | `/v1/batches` | ❌ **broken** | `400 missing model` | A batch create body has no `model` field. |
| 9 | GET | `/v1/batches/{id}` | ❌ **broken** | `400 invalid JSON body` | |
| 10 | POST | `/v1/files` | ❌ **broken** | `400 missing model` | Multipart upload; no JSON body at all. |
| 11 | GET | `/v1/files` | ❌ **broken** | `400 invalid JSON body` | |
| 12 | GET | `/v1/files/{id}` | ❌ **broken** | `400 invalid JSON body` | |
| 13 | DELETE | `/v1/files/{id}` | ❌ **broken** | `400 invalid JSON body` | Also sent upstream as **POST** (method is hardcoded). |
| 14 | POST | `/v1/vector_stores` | ❌ **broken** | `400 missing model` | |
| 15 | GET | `/v1/vector_stores` | ❌ **broken** | `400 invalid JSON body` | |

**Score: 2 fully native, 4 conditionally forwarded, 9 broken.**

### 3.1 The catch-all also swallows endpoints that were never requested
`POST /v1/audio/speech`, `POST /v1/images/generations` and `POST /v1/rerank` all
return `401` for a bad key — identical to the endpoints above — despite having no
support whatsoever. **Auth is evaluated before path support**, so a `401` proves
only that the catch-all matched, never that the endpoint works. Any future
"is endpoint X supported?" question must be answered with a *valid* key, not by
status code.

---

## 4. Root cause — three assumptions in one handler

`ServeGeneric` (`internal/proxy/proxy.go`) makes three assumptions that hold for
chat-style calls and fail for everything else:

1. **A JSON body with `model` is mandatory.**
   ```go
   if err := json.Unmarshal(body, &req); err != nil {   // proxy.go:486
       h.writeErr(w, http.StatusBadRequest, "invalid JSON body"); return
   }
   slug, _ := req["model"].(string)
   if slug == "" {                                       // proxy.go:492
       h.writeErr(w, http.StatusBadRequest, "missing model"); return
   }
   ```
   Consequence: `files` / `batches` / `vector_stores` (no `model`) die at `400`,
   and every GET/DELETE (no body) dies at `400` before any routing decision.

2. **The upstream method is always POST.**
   ```go
   upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upURL, …)  // proxy.go:545
   ```
   `r.Method` is ignored. A `DELETE /v1/files/{id}` reaches the upstream as a POST.

3. **The path is forwarded without the query string.**
   ```go
   upURL := strings.TrimRight(m.BaseURL, "/") + strings.TrimPrefix(r.URL.Path, "/v1")  // proxy.go:519
   ```
   `r.URL.RawQuery` is dropped, so `?api-version=…`, `?limit=…`, pagination and
   `?after=` cursors are lost.

Two further gaps:

4. **No `stream_options` injection.** Only the chat path injects
   `stream_options.include_usage` (`proxy.go:233-234`). A streaming call through
   the generic path has no usage block to read, so `tokens_in/out` stay 0 and the
   call is recorded at **zero cost**.
5. **`model` doubles as the routing key.** The generic path resolves the
   provider *from the model slug*, so an endpoint that legitimately has no
   `model` (files, batches, vector stores) has no way to select an upstream at
   all. This is a design gap, not a validation bug.

**Note on what the generic path gets right:** it authenticates, enforces
`api_key.limits`, fails over across ≤3 pooled accounts on 401/403, relays only an
allowlisted set of response headers, and writes a `request_log` row on every
outcome. The defects above are about *forwarding fidelity*, not about billing
integrity — except #4, which silently zeroes cost.

---

## 5. What each endpoint actually needs

The list splits into three genuinely different kinds of work.

### Tier A — pass-through (no server state)
`/v1/responses`, `/v1/completions`, `/v1/embeddings`, `/v1/moderations`

These are stateless calls that name a model and are proxied. They already work
when `model` is present. The work is to make forwarding faithful and billing
correct — no new tables.

### Tier B — read-only projections of our own data
`GET /v1/models/{model}`

Purely local: serve one row from `store.ActiveModels` by slug. No upstream call.

### Tier C — stateful resources (the router must own state)
`/v1/files`, `/v1/batches`, `/v1/vector_stores`

These cannot be pass-through. A file uploaded to us must be stored (and its
bytes re-sent to whichever upstream serves the later batch); a batch is a job we
own with a lifecycle; a vector store is a container we own. Each needs its own
tables, its own ownership rules (which `api_key`/`user` owns the object), and its
own authz — this is a real feature, not a routing fix.

---

## 6. Implementation plan

### P0 — Correct the generic forwarder (unblocks Tier A)
1. **Don't require a JSON body or `model` for every request.** Only parse/require
   `model` when the path is a model-addressed inference endpoint. Introduce an
   explicit path allowlist for "needs model" rather than a blanket rule.
2. **Forward the real method** — `r.Method`, not `http.MethodPost`.
3. **Forward the query string** — append `r.URL.RawQuery`.
4. **Pass the request `Content-Type` through** and stop force-JSON-parsing bodies
   that are not JSON (multipart, empty).
5. **Inject `stream_options.include_usage` on the generic path too** when the body
   is JSON and `stream: true`, so streaming calls are billed.
6. **Map "no model in the body" to a provider-selection strategy** for Tier C
   (see P2) instead of a `400`.

*Acceptance:* all four Tier A endpoints return the upstream's real response with
the correct method, path and query, and a streaming call records non-zero tokens.

### P1 — `GET /v1/models/{model}`
Register a native route ahead of the catch-all (`GET /v1/models/`). Return
`{id, object: "model", owned_by, context, pricing}` for a published slug, `404`
for an unpublished or unknown one. **Public, like `/v1/models`** — same rationale:
the catalog is not a protected resource.

### P2 — Stateful resources
Requires new schema (a migration, and therefore the deploy-time migration step
the audit flagged as missing — see `C3` in `AUDIT-fudrouter-2026-09-25.md`):

- `file_object` — `id`, `api_key_id`, `user_id`, `purpose`, `bytes` (or an
  object-store key), `filename`, `created_at`, `deleted_at`.
- `batch_job` — `id`, `api_key_id`, `user_id`, `input_file_id`, `endpoint`,
  `status`, `output_file_id`, `error_file_id`, timestamps.
- `vector_store` — `id`, `api_key_id`, `user_id`, `name`, `status`, `created_at`.

Each needs: owner-scoped queries (no IDOR — mirror the pattern already used on
the member surface), soft delete, and a background worker for batch execution.
**Recommendation: do not start P2 until P0/P1 ship and the deploy-time migration
gap is closed**, or a release will run new code against an old schema.

---

## 7. Acceptance criteria

- Every endpoint in §3 marked ✅ or ⚠️ behaves correctly with a **valid** key,
  and returns a truthful `404` (not `401`) when the path genuinely has no route.
- A `DELETE` reaches the upstream as a `DELETE`; a query string survives.
- A streamed call on any Tier A endpoint writes `tokens_in > 0` to `request_log`.
- `/v1/models/{model}` returns the same fields `/v1/models` returns, for one slug.
- **A test pins the surface.** Today nothing asserts which paths exist, which is
  why the catch-all could quietly pretend to serve eleven endpoints it cannot.
  Add a table-driven test in `services/router` that hits every path in §3 with a
  seeded key and asserts the expected status — so adding a route without updating
  this spec fails CI.

---

## 8. Non-goals / open questions

- **Not in scope:** `/v1/audio/*`, `/v1/images/*`, `/v1/rerank`, `/v1/fine_tuning/*`
  — not requested, not designed, and currently indistinguishable from the
  supported surface because of the catch-all.
- **Open:** should the catch-all return `404` for unimplemented `/v1/*` paths?
  It would be honest, but it would also break the "forward anything to the
  upstream" escape hatch that makes ad-hoc endpoints work today. Decide
  deliberately; do not leave it implicit.
- **Open:** the coding-plan surface `/coding/v1` (advertised as a preview on
  `/models` and `/pricing`) is **not routed at all**. It is a separate prefix and
  needs its own decision — see the main audit's catalog notes.
