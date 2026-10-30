# 9Router Pro parity: prompt injection, combos, Gemini /v1beta

Status: shipped 2026-10-30. Three capabilities that 9router-pro had and this
router did not. Everything else about 9router-pro (Next.js monolith, SQLite,
single-operator, plaintext keys) was deliberately NOT ported — see
`2026-10-22-9router-benchmark.md` for that comparison.

## What shipped

### 1. Prompt injection (`prompt_injection` table)

Server-side rewrite of a chat request body, per scope, so an operator can pin a
persona or a guardrail onto traffic without touching the client.

- **Scopes**, resolved in a fixed order and applied at most once each:
  `account` → `api_key` → `model`. A model scope may target either the slug the
  client asked for or the canonical slug it resolved to.
- **Modes**: `system_prepend` (new leading system message, or prepend into the
  existing one), `system_append` (append to the trailing system message), and
  `chat_script` (synthetic `user:`/`bot:` turn pairs injected before the last
  user turn, legacy text-completion style).
- **Fail-open, always**: a body that is not a JSON object, has no messages
  array, or cannot be re-encoded is returned byte-identical. Injection can
  never turn a working call into a 400.
- Cached in Valkey for 30s (empty results included) so the hot path does not pay
  a Postgres round-trip per request.
- Applied AFTER `injectUnrestricted` and before the attempt loop, so it is
  upstream-agnostic and does not interact with failover.
- Surfaces: `GET/POST /api/pages/injections`, `POST /api/pages/injections/create`,
  `POST /api/pages/injections/delete`, and the dashboard page
  `/dashboard/injections`.

### 2. Combos

`combo` + `combo_model` already existed as tables (migration `0021`) with a
resolver in the routing layer; what was missing was the product around it. Now:

- Console CRUD: `GET /api/pages/combos`, `POST /api/pages/combos/create`,
  `POST /api/pages/combos/delete`.
- Dashboard page `/dashboard/combos` with an ordered hop builder — hops are
  added one at a time by design, because the operator's order IS the failover
  order and a multi-select would silently reorder it.
- A request whose `model` is a combo name is resolved by the routing layer like
  any other model; each hop that gets tried writes its own `request_attempt`
  row, so failover inside a combo is auditable.

### 3. Gemini `/v1beta` native surface

New file `backend/go/internal/proxy/gemini.go`. The router previously answered
404 for every Gemini path, so a Google SDK could not be pointed at it. Now:

| Route | Behaviour |
| --- | --- |
| `GET /v1beta/models` | published catalogue in the Gemini list shape |
| `GET /v1beta/models/{model}` | one model, `supportedGenerationMethods` included |
| `POST /v1beta/models/{model}:generateContent` | buffered answer |
| `POST /v1beta/models/{model}:streamGenerateContent` | SSE, one `data:` event per chunk, final event carries `usageMetadata` |
| `POST /v1beta/models/{model}:countTokens` | documented estimate (no Gemini tokenizer upstream) |

Design notes:

- The Gemini body is translated to an `[OI]` chat body and then **runs the
  shared lifecycle** (`begin` → dispatch → failover → billing → ledger). Billing,
  budgets, rate limits and the error taxonomy are NOT re-implemented; a
  `generateContent` call is billed exactly like a chat call.
- Streaming sets `stream: true` + `stream_options.include_usage` upstream, so the
  final Gemini event can carry real `usageMetadata` instead of zeros.
- `lifecycle.wire` replaced the old `anthropic bool`, so a rejection is written
  in the caller's own envelope: `{"error":{"code","message","status"}}` for
  `/v1beta`, `{"type":"error",...}` for `/v1/messages`.

## Verification

```bash
# translation unit tests + the injection unit test
cd backend/go && go test ./internal/proxy/ -run 'Gemini|Injection|Script' -count=1

# full suite needs a throwaway database, not the live one
createdb fudrouter_test && DATABASE_URL=…/fudrouter_test ops/migrate.sh
DATABASE_URL=…/fudrouter_test go test ./... -count=1

# live, against the running router (mints and revokes a temp key itself)
node ops/verify-prompt-injection.mjs    # 13 checks
node ops/verify-gemini.mjs              # 15 checks
node ops/verify-anthropic.mjs           # 4 checks
```

All three live scripts pass end to end. `verify-prompt-injection.mjs` proves the
three scopes by quoting markers that can only appear if the router rewrote the
body; `verify-gemini.mjs` proves the streaming path (SSE events, accumulated
text, trailing usage) plus the 401/404/400 envelopes.

## Pitfall worth remembering

A reasoning model with `max_tokens` too small returns `content: ""` and
`finish_reason: "length"` — the tokens went into thinking, not the answer. When
testing an injection with a distinctive marker, budget at least a few hundred
tokens or the failure looks like a broken injection.
