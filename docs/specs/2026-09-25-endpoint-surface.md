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
at a base URL and expect the [OI] surface. Today the router registers **seven**
routes and lets a catch-all absorb everything else:

```go
// services/router/internal/proxy/proxy.go:96-106
mux.Handle("GET /health",               health)
mux.Handle("GET /v1/models",            http.HandlerFunc(p.ServeModels))
mux.Handle("GET /v1/models/",           http.HandlerFunc(p.ServeModel))
mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))
mux.Handle("POST /v1/messages",             http.HandlerFunc(p.ServeMessages))
mux.Handle("POST /v1/messages/count_tokens", http.HandlerFunc(p.ServeCountTokens))
mux.Handle("/v1/",                      http.HandlerFunc(p.ServeGeneric))  // catch-all
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
| `GET` | `/health` | `newHealthHandler` | Pings the DB and returns `503` when it is unreachable (audit H5, fixed 2026-09-26). |
| `GET` | `/v1/models` | `ServeModels` | **Native, unauthenticated.** Confirmed 2026-09-26 to be a deliberate status quo: the same catalog is already public at `GET /models` and `GET /pricing`. |
| `GET` | `/v1/models/{model}` | `ServeModel` | **Native, unauthenticated.** One published slug; `404` for an unknown/unpublished one. |
| `POST` | `/v1/chat/completions` | `ServeCompletions` | **Native and complete.** Auth, limits, `stream_options.include_usage` injection, ≤3-account failover, SSE, billing on every outcome. |
| `POST` | `/v1/messages` | `ServeMessages` | **Native and complete (added 2026-10-03).** The Anthropic Messages surface: native inbound translation, same auth/limits/routing/billing as chat, SSE. See §2.2. |
| `POST` | `/v1/messages/count_tokens` | `ServeCountTokens` | **Native (added 2026-10-03).** Local estimate, no upstream round-trip, never billed. |
| any | `/v1/*` | `ServeGeneric` | **Generic passthrough.** Authenticates, enforces limits, fails over, bills — but forwards the request incorrectly (see §4). |

That is the whole surface. Everything else is the catch-all.

### 2.1 Why `/v1/models` stays unauthenticated

Authenticating it was proposed on 2026-09-26 and **rejected on evidence**. The
catalog is not merely reachable without a key here; the web app already publishes
the identical set:

```
GET /models   -> 200, anonymous   270/270 published slugs rendered
GET /pricing  -> 200, anonymous
```

Measured by diffing the rendered HTML against the database: the 270 slugs that pass
the web page's own publish gate (`reachability()` in `shared/control-lib/publish.ts`)
are **all** present in the anonymous response, whether as a `<code class="slug">`
or as the card title. Requiring a key on `/v1/models` would therefore hide nothing
while breaking every client whose only capability is the catalogue — the SDK and
UI model-picker probes that run at startup.

Note the two gates are the same rule implemented twice (`m.status='active' and
(p.status='active' or (p.status='dev' and $1))` in
`services/router/internal/store/store.go:194`, mirrored in `publish.ts`), so the
two views cannot drift.

One consequence to keep in mind: the slug prefix is a provider label (`ag/`,
`crypto/`, `openai/`), so the public catalogue discloses which upstreams are
carried. That is a disclosure decision, and it is a product one — see the audit's
open findings — not a defect in the endpoint.

---

## 2.2 The Anthropic Messages surface (added 2026-10-03)

The router now serves the **Anthropic Messages API** natively, so an
Anthropic-shaped client (the [CC] CLI, an Anthropic SDK, any tool that speaks
`/v1/messages`) points at the router with no translator in front.

**Routes.** `POST /v1/messages` and `POST /v1/messages/count_tokens`. Both are
registered ahead of the catch-all, so the catch-all's `401`-for-everything
behaviour no longer masks them.

**Credential carriers.** Two are accepted, because the two inbound protocols use
different conventions:

| Carrier | Protocol | Notes |
|---|---|---|
| `Authorization: Bearer sk-ar-…` | [OI] | Wins when both are present. |
| `x-api-key: sk-ar-…` | Anthropic | The native Anthropic convention; no `Authorization` header. |

`authenticate` (`internal/proxy/auth.go`) resolves either carrier before
`keys.Parse`, so a client only ever needs the one header its protocol uses.
Sending neither — or an `Authorization` that is not `Bearer` — is the only case
that still reports `missing bearer token`.

**Shape.** A native request is translated inbound to the router's internal
chat-completions shape (system prompt, tool definitions, tool choice, images,
`max_tokens` → `max_output_tokens`), routed like any other call, and the
response is translated back out: `{"type":"message","content":[{"type":"text",…}],"usage":{…}}`,
with `input_tokens`/`output_tokens` mirroring the chat path's
`prompt_tokens`/`completion_tokens`. Streaming is SSE in the Anthropic event
grammar (`message_start`, `content_block_delta`, `message_delta`, `message_stop`).

**Errors.** The error body is Anthropic-shaped — `{"type":"error","error":{"type":…,"message":…}}` —
so an Anthropic client parses it without a shim. The `error.type` values map
from the router's `routing.ErrCode*` constants (`AUTHENTICATION_ERROR` →
`authentication_error`, `RATE_LIMITED` → `rate_limit_error`, …).

**Billing.** Identical to chat: the same `request_log` row, the same limit
enforcement, the same ≤3-account failover. `count_tokens` is a local estimate
and writes no billable usage.

**Evidence.** The `apps/web/scripts/e2e-smoke.mjs` acceptance run exercises the
surface end to end over real HTTP — an unauthenticated `401` in Anthropic shape,
an authenticated `200` with Anthropic content blocks and usage, and a positive
`count_tokens` — and passes as part of the standard smoke (`24 passed, 0 failed`
on 2026-10-03).

---

## 3. Requested surface vs. reality

Measured against an isolated instance serving a mock provider. `model` column =
whether the endpoint requires a JSON body carrying `model`.

| # | Method | Endpoint | Status | Observed | Note |
|---|---|---|---|---|---|
| 1 | POST | `/v1/responses` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /responses` | Works, but only because the client happens to send `model`. No `stream_options` injection → a streamed `/v1/responses` is likely **unbilled**. |
| 2 | POST | `/v1/chat/completions` | ✅ **native** | full hot path | Reference implementation. |
| 3 | POST | `/v1/completions` | ⚠️ **forwarded, conditional** | `200` → upstream saw `POST /completions` | Same `model` dependency. |
| 4 | GET | `/v1/models` | ✅ **native** | `200 {"data":[…]}` | Unauthenticated. See §2.1. |
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
- **Both credential carriers work on the Anthropic surface.** `x-api-key` and
  `Authorization: Bearer` must each authenticate a `/v1/messages` call, and an
  unauthenticated one must return an Anthropic-shaped `401`. Pinned by
  `TestBearerOrAPIKey` (unit) and the `/v1/messages` steps in `e2e-smoke.mjs`
  (live).

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
