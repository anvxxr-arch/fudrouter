# Benchmark: FUDRouter vs 9Router

Competitive baseline recorded 2026-10-22 against `decolua/9router` @ `master`
(31.2k stars, 6.0k forks, MIT). Every 9Router claim below is read from its source,
not its README; every FUDRouter claim is read from this repo or the live database.
Line references are to the files named.

## What each product is

| | 9Router | FUDRouter |
|---|---|---|
| Shape | Local single-user gateway + dashboard | Commercial multi-tenant router |
| Runtime | Next.js monolith (`src/app/api/*` serves both `/v1` and `/api`) | Go data plane + Express control plane |
| State | SQLite file (`src/lib/db/index.js` → `getAdapter()`) | Postgres, 42 tables |
| Money | None — usage tracking only | `credit_ledger` + `usage_charge`, idempotent |
| Tenancy | One operator; `machineId` baked into the key | Real accounts; per-account keys, budgets, ledger |
| Licence | MIT, self-host | Commercial |

They overlap on the hot path — one `/v1` endpoint, many providers, fallback,
multi-account rotation. They diverge completely on what happens around it.

## Verified capability matrix

| Capability | 9Router | FUDRouter | Evidence |
|---|---|---|---|
| `/v1/chat/completions` | yes | yes | `proxy.go:127` |
| `/v1/models` | yes | yes, unauthenticated | `proxy.go`, contracts |
| Anthropic `/v1/messages` | yes | **yes, native + tool translation** | `anthropic.go:4-6`, `anthropic_translate_test.go:144` |
| `/v1/messages/count_tokens` | yes | yes (documented estimate) | `anthropic.go:146-154` |
| Gemini `/v1beta` | yes | **no** | routes.json has no `/v1beta` |
| Format translation | [OI]↔Claude↔Gemini↔Cursor↔Kiro↔Vertex | [OI]↔Anthropic only | `anthropic.go` |
| Multi-account rotation | yes | yes, credential pool | `pool.go`, `targets.go:29` |
| Auto token refresh | yes | yes (xAI, guarded) | `pool.go:545`, `pool_xai_guard_test.go` |
| OAuth providers | [CC], Codex, Gemini, GitHub, Cursor, Kiro, Antigravity | xAI refresher only | `pool.go:580` |
| Token compression | **RTK, 20-40% input savings** | **none** | README feature table |
| Combos (model sequences) | **yes, headline feature** | **no table, no route** | `combo` relation absent in live DB |
| Prompt-injection savers | Caveman, Ponytail | no | README |
| Billing / credits | **none** | ledger, exactly-once | `logs.go:189-193` |
| Budgets + hard stop | none | 70/90/100, `action_at_100=block` | `budget.go:24` |
| Idempotent charging | n/a | `usage:<request id>` | `logs.go:193` |
| API key storage | **plaintext in SQLite; exported by `exportDb()`** | `sha256(secret)` only | see below |
| Key generation | `Math.random()`, hardcoded default secret | CSPRNG, per-key secret | see below |
| SSRF boundary | none stated | `netguard` at `Dialer.Control` | `netguard.go`, `guard.go` |
| Plane separation | single process | Go re-authenticates independently | `auth.go:14-21` |
| Audit trail | request log | `audit_log`, `request_attempt` | `audit.mjs` |
| TTFT instrumentation | none | `ttft_ms` per request | `stream_ttft_test.go` |
| Retention policy | none | explicit, deletion opt-in | `workers.ts:1049` |
| CLI / tray | yes | no | `cli/`, `cli/src/cli/tray/` |
| Self-hosted STT/TTS | yes | embeddings pass-through only | README |

## Where 9Router is genuinely ahead

Three of these are real product advantages, not cosmetic.

1. **Token economics.** RTK compresses `tool_result` payloads (`git diff`, `grep`,
   `ls`, `tree`, log dumps) before dispatch, claiming 20-40% input-token savings;
   Caveman and Ponytail attack output tokens by prompt injection. FUDRouter has no
   equivalent at any layer. For a coding-agent workload this is the single largest
   cost lever either product has, and it is the one we do not pull.

2. **Combos.** A named sequence of models that the router walks when the previous
   one fails. This is 9Router's headline feature and the reason people adopt it.
   FUDRouter has a candidate walker (`routing.Execute`, `maxPickAttempts=20`) but no
   user-defined sequence above it.

3. **Breadth of client compatibility.** 40+ providers, 20+ CLI tools, six wire
   formats. Our `/v1` is compatible with the dominant SDK convention and native for
   two families; the other four are unmodelled.

4. **Distribution.** npm global install, Docker, Cloudflare Workers, a tray app.
   We deploy with PM2 on one host.

## Where FUDRouter is ahead

These are structural and cannot be copied by adding a feature.

1. **Money is exact.** `credit_ledger` is keyed `usage:<request id>`, so a retry
   cannot double-charge; `balance_micro` is a cache and the ledger is truth. 9Router
   has no billing at all, so it has nothing to be exact about.

2. **Key material is not recoverable.** We store `sha256(secret)`. 9Router stores
   the plaintext key in the `apiKeys.key` column and `exportDb()` emits it verbatim
   (`db/index.js`: `apiKeys: db.all('SELECT * FROM apiKeys').map(r => ({ id, key: r.key, … }))`),
   so any backup file contains working keys.

3. **Key generation is not a coin flip.** 9Router's `generateKeyId()` uses
   `Math.random()`, and `API_KEY_SECRET` falls back to the literal
   `"endpoint-proxy-api-key-secret"` when unset — with that default, a CRC is
   forgeable by anyone who reads the source. The key is `sk-{machineId}-{keyId}-{crc8}`
   where `crc8` is `HMAC-SHA256(secret, machineId+keyId)` truncated to 32 bits.

4. **The planes do not trust each other.** Go re-authenticates every key, re-resolves
   limits, and carries its own SSRF guard, so a compromised console cannot mint
   traffic the router accepts. 9Router's dashboard API and `/v1` share a process and
   a SQLite handle.

5. **Every hop is auditable.** `request_attempt` records each provider attempt, so
   "which upstream served this and what did it cost" is a query, not a log grep.

## The five steps

Ordered by value per unit of work. Each is measurable, and each either closes a gap
9Router owns or widens a moat it cannot cross.

### Step 1 — Metered token compression

Match RTK's compression, then do the thing RTK cannot: **charge for the saving and
prove it**.

- Compress `tool_result` / `tool` message content before dispatch, with the same
  filter family (git-diff, grep, ls/tree, log dedup, smart truncate).
- Fail open: any filter error, or a result that grew, keeps the original bytes.
- Record `tokens_saved` on `request_log` and emit it in the `event: metrics` frame.
- **Acceptance:** a request carrying a 40 KB `git diff` tool result shows
  `tokens_saved > 0` in `request_log`, the compressed body still parses as the same
  message shape, and a filter that throws leaves the request byte-identical.

### Step 2 — Combos as first-class routing

- A `combo` table (id, account_id, name, ordered model list) and one resolution
  step that expands a combo name into the existing candidate sequence.
- Reuse `routing.Filter`/`Select`/`Execute`; do not write a second walker.
- **Acceptance:** a two-model combo whose first upstream returns 500 produces two
  `request_attempt` rows, one `usage_charge`, and the client sees one response.

### Step 3 — Per-key hard spend cap  ✅ shipped

The cap itself already existed: `BudgetsFor` selects both `scope = 'account'`
and `scope = 'api_key'`, and `checkBudgets` blocks at 100% when
`action_at_100 = 'block'`. What this step actually delivered was **proving it and
fixing the reason it did not work**.

- **Fixed:** `AdmissionBudgets` cached its result under the account id alone
  (`budgetCacheKey{k.UserID}`) while the query depends on the key id too. Two
  keys on one account therefore shared whichever chain was cached first, so a
  per-key cap could refuse the wrong key and a key's own cap went unread for the
  whole TTL. Keyed by `{accountID, apiKeyID}` now.
- **Tests:** the per-key cap had no coverage at all — only the account half of
  the chain was exercised. Added admission-order tests that assert 402 *and*
  zero upstream dials, plus a two-key case that runs the uncapped key first to
  populate the cache.
- **Acceptance (met):** a key at its cap returns 402 with the upstream never
  dialled; with the coarse cache key the two-key test returns 200 instead of 402.
- **Known limit:** the budget cache has no manual invalidator, so a cap created
  or raised from the console is dormant for up to `policyTTL` (60s).

### Step 4 — Third native protocol

- `/v1beta/models` and Gemini `generateContent` translation into the [OI] request
  the data plane already speaks, metered and logged like everything else.
- **Acceptance:** a Gemini-shaped client gets a valid response, and the request
  appears in `request_log` with the same cost fields as a chat completion.

### Step 5 — Provable security posture  ✅ shipped

- Assert the properties we already have, as tests rather than prose: a database dump
  contains no usable key material, and a forged key fails authentication.
- **Acceptance (met):** `TestNoPlaintextSecretAtRest` pins that the stored value
  is a sha256 digest which neither contains the secret nor authenticates as it.
  Mutation-verified: returning the secret from `Hash` turns it red.
- **Also fixed under this step:** the key charset accepted only `[A-Za-z0-9]`
  while the minter emits base64url, so 5 of 69 live keys were unauthenticatable
  (`docs/changelog/2026-10-22-key-charset-outage.md`).

Steps 1 and 2 close the two gaps that decide adoption. Steps 3 and 5 are cheap and
make the commercial claim defensible. Step 4 is parity, not differentiation.

## Non-goals

- **Do not copy the tray app or MIT self-host packaging.** Different business.
- **Do not copy prompt-injection savers** (Caveman, Ponytail). They change model
  output quality on the customer's behalf without telling them; that belongs in the
  client, not the billing plane.
- **Do not copy `machineId`-in-key.** It is a single-user design that would leak
  host identity into a multi-tenant key.
