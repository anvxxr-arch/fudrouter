# Platform schema & domain contract
**Date:** 2026-09-30
**Status:** Accepted — source of truth for every plane's data access
**Scope:** whole platform (apps/react-web control plane, services/router data plane, infra/migrations)
**Supersedes:** nothing. Extends `2026-09-21-s0-foundation-design.md` (flat S0 schema) to the
PRD's resource model: `User → Workspace → Project → Environment → API Key` and
`Model → Provider Model → Provider → Connection → Credential`, with
`Request → Attempts → Usage → Cost`.
**Evidence:** table names/columns below are the literal DDL shipped in
`infra/migrations/0006_platform_schema.sql` + `0007_platform_cutover.sql`; live row counts at
design time were 3 users / 9 keys / 9 providers / 308 models / 30 request_log rows
(`postgres-hardened`, db `fudrouter`).

---
## 0. Why this document exists
S0 was deliberately flat: `api_key.user_id`, `model.provider_id`, `request_log` as a single
cost ledger. The PRD's acceptance criteria (§144–146) require the full hierarchy above, a
versioned pricing engine, a credit ledger, per-attempt routing traces, and PostgreSQL as the
only durable source of truth. Every one of those is a schema decision first. This document
fixes the durable model and the module boundaries so the control plane, the data plane and
the migration can be built in parallel without renegotiating names.

Two conventions outrank the PRD's illustrative lists (PRD §78: consistent naming beats
matching the doc):
1. **Table names are singular** (`workspace`, `request_log`), matching S0.
2. **Money never touches a float.** Costs are `bigint` integer micro-units
   ($1 = 1_000_000). Unit prices are `numeric(18,6)` micro-units per 1M tokens.

---
## 1. Public IDs (PRD §81)
Every entity gets a **prefixed, public-safe ID**: `<prefix>_<uuidv7-lowercase>` —
roughly time-ordered, non-sequential, safe to show in URLs and logs.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `usr_` | user | `mdl_` | model (canonical) |
| `wrk_` | workspace | `pmdl_` | provider_model |
| `mem_` | workspace_member | `als_` | model_alias |
| `rol_` | workspace_role | `rte_` | routing_policy |
| `prj_` | project | `prc_` | pricing_rule |
| `env_` | environment | `req_` | request_log |
| `key_` | api_key | `rta_` | request_attempt |
| `prv_` | provider | `bac_` | billing_account |
| `con_` | connection | `txn_` | credit_ledger |
| `cred_` | credential | `inv_` | invoice |
| `bdg_` | budget | `whk_` | webhook |
| `lim_` | rate_limit | `whd_` | webhook_delivery |
| `alr_` | alert | `job_` | job |
| `ale_` | alert_event | `evt_` | system_event |
| `aud_` | audit_log | `inc_` | incident |
| `icu_` | incident_update | `flg_` | feature_flag |
| `rul_` | security_rule | `cbr_` | circuit_breaker |

Rules:
- Generated **app-side** (never `serial`). TS: `newId(prefix)` in `shared/control-lib/server/id.ts`
  (`uuidv7` package). Go: `ids.New(prefix)` in `services/router/internal/ids`
  (`gofrs/uuid` NewV7), formatted the same way.
- **Backfilled IDs are `<prefix>_<legacy id>`, legacy id verbatim.** S0 ids are mixed-shape
  (live evidence: `user.id` = Better Auth nanoid `u_…`/32-char, `api_key.id`/`model.id`/
  `request_log.id` = uuidv7, `provider.id` = slug `mingles`), so the backfill wraps whatever
  exists (`usr_u_apkpg2yCQHFi`, `prv_mingles`) instead of minting new identities — history and
  FKs survive intact. Prefix strip = split on the first `_`.
- Better Auth mints its own rows, so `advanced.database.generateId({ model })` in
  `apps/react-web/server/index.mjs` maps model→prefix (`user`→`usr_`, `session`→`ses_`,
  `account`→`acc_`, `verification`→`ver_`).
- S0 rows are rewritten in `0007` (prefix + existing uuid), keeping every FK consistent.
  The rewrite is idempotent (`where id not like 'usr\_%'` style guards) and backfills only.

Existing S0 columns keep their names unless this doc says otherwise: the ledger is
`request_log` (PRD calls it `requests`; §78 explicitly allows this), and `api_key.limits`
jsonb is kept as a **legacy column** until its last caller migrates (§3).

**Migration sequencing** — every file must leave the tree runnable at that commit:
- `0006` — additive only: new tables, new nullable/defaulted columns. Old code unaffected.
- `0007` — data backfill only (id wraps, hierarchy, split rows, seeds). No drops.
- `0008_request_client_ip` — additive only: the `request_log.client_ip` column
  PRD §29/§70 need (added after the initial additive file proved too thin).
- `0009_widen_status_vocabularies` — **WIDEN ONLY, no value migration.** The
  0005 CHECKs rejected the PRD §52/§125 status values on every write (AdminOps,
  2026-09-30). Constraints now accept the UNION (S0 `active|dev|inactive` +
  PRD `operational|degraded|maintenance|outage|deprecated|sunset|disabled`) so
  both vocabularies coexist in the transition window; every reader already
  speaks both (the router's `providerServableSQL` is dual-vocabulary).
- `0010` (lands in ONE commit with every writer of those values) — **narrow +
  value migration + predicate flips**: map `active`/`dev` → `operational`,
  `inactive` → `deprecated`, narrow both CHECKs to the PRD sets, add the
  `request_log.status` constraint (spec §8 taxonomy) once the data plane's old
  `error`/`upstream_error` writers are gone.
  **The sweep that must be in the SAME commit** (miss one and the constraint
  rejects live writes or the public catalog goes dark):
  - `services/router/**` Go status writers (`logRequest` call sites).
  - `shared/control-lib/publish.ts` reachability predicate (`p.status === 'active'`
    → `'operational'`; also the mirrored SQL in `services/router/internal/store`).
    **Sharpest cutover risk in the wave: flip this and the migration together or
    every published model vanishes from `/models` and `/v1/models`.**
  - `shared/control-lib/provider-catalog.ts` (and the React status UI under
    `apps/react-web/src/routes/`), admin
    provider/model form status dropdowns (`routes/admin/providers/**`,
    `routes/admin/models/**`).
  - the retired `apps/web/scripts/*.mjs` onboarding/verify scripts (27 files) — the
    easy miss; they were removed with the Svelte app (2026-10-06) and the React app
    ships no equivalent. The literal inventory below is kept as the sweep record.
    Concrete literal inventory (36 hits / 8 files), captured 2026-09-30:
    `onboard-googleai.mjs`, `onboard-openrouter.mjs`, `onboard-xai-grok.mjs`,
    `prune-unikey-catalog.mjs`, `seed.mjs`, `verify-freebuff.mjs`,
    `verify-inferhub.mjs`, `verify-xai.mjs` (grep `'active'|'dev'|'inactive'`).
  - the retired `apps/web/src/lib/server/route-gates.test.ts` and its sibling tests
    pinning old literals — removed with the Svelte app (2026-10-06).

  **Model-side needs NO predicate change**: both the router (`m.status = 'active'`)
  and `publish.ts` (`isPublished` → `=== 'active'`) already gate on `active`, so
  `deprecated`/`sunset`/`inactive` models are consistently hidden on both sides.
  The ONLY predicate drift is the **provider on-gate**:
  `services/router/internal/store/catalog.go` `providerServableSQL` already reads
  BOTH vocabularies (`p.status not in ('disabled','maintenance','outage')`), but
  `publish.ts` `reachability()` only recognizes `'active'`/`'dev'`. So today a
  provider whose `status` is `'operational'`/`'degraded'` is SERVED by the router
  but HIDDEN by the console/catalog. No such row exists yet (all 9 providers are
  `commercial|active`), so the drift is latent; it surfaces the moment an admin
  writes a PRD status via `admin-vocab.ts` (which emits `operational`/…).
  **0010 closes it** by flipping `reachability()`'s provider gate to the PRD set
  in the same commit as the value migration. Until then, provider writes on
  legacy `active`/`dev` stay consistent; a PRD `operational`/`degraded` provider
  is served-but-catalogued-dark as a known transition gap.

  The 0010 cutover is staged at `backend/go/migrations/0010_platform_status_narrow.sql`
  (ready to apply, NOT applied). Do not run it until the writer/predicate flips
  land in the same commit.
- Final wave — **legacy column drops; number `0012` reserved, migration NOT yet
  authored** (the `0011` slot is taken by `0011_request_log_nullability.sql`,
  which shipped to relax `request_log.model_id`/`provider_id`). When the last
  caller is gone, write `0012_legacy_column_drop.sql` in the SAME commit that
  removes those callers, and only then — a staged drop would fire early because
  `migrate.sh` applies every pending file (that is what makes the single-gate
  `0010` staging safe and a second differently-gated staging unsafe). Drops:
  `provider.base_url`, `provider.credentials_enc`, `model.input_price`, `model.output_price`,
  `api_key.limits`, `request_log.tokens_in/tokens_out/cost`.
  **MUST NOT land while any caller remains.** All six columns are still live
  today; no migration drops them yet.

---
## 2. Accounts & workspace hierarchy (PRD §6, §44–46)

```
workspace      (id, name, slug unique, owner_user_id → user, status active|archived|suspended,
                settings jsonb, created_at, updated_at)
workspace_role (id, workspace_id NULL = builtin template, name, permissions jsonb,
                created_at; unique (workspace_id, name))
workspace_member (id, workspace_id, user_id, role_id → workspace_role, status
                active|invited|suspended, invited_by, created_at, updated_at;
                unique (workspace_id, user_id))
project        (id, workspace_id, name, slug, description, status active|archived|suspended,
                created_at, updated_at; unique (workspace_id, slug))
environment    (id, project_id, name, slug, type development|staging|production|custom,
                status active|disabled, routing_policy_id NULL → routing_policy,
                monthly_budget_micro bigint NULL, created_at, updated_at;
                unique (project_id, slug))
```

Builtin roles seed as `workspace_role` rows with `workspace_id NULL`:
`owner`, `admin`, `developer`, `billing`, `viewer`. Permissions are the PRD §46 codes
(`project.read`, `key.create`, `routing.write`, `billing.read`, `member.invite`, …); a role is
a **collection of permission codes** (stored `jsonb` array), so custom roles are a data change,
not a schema change. `workspace_member.role_id` points at the role row the member uses
(builtin template or workspace-custom). Permission codes (complete list):
`workspace.read, workspace.write, workspace.delete, member.read, member.invite, member.remove,
project.read, project.write, project.delete, key.read, key.create, key.rotate, key.revoke,
routing.read, routing.write, alias.read, alias.write, request.read, analytics.read, usage.read,
budget.read, budget.write, limit.read, limit.write, alert.read, alert.write, webhook.read,
webhook.write, billing.read, billing.write`.
Builtin matrix (TS `lib/server/rbac.ts` `WORKSPACE_ROLES`, seeded into `workspace_role` rows):
- `owner` — all codes (only role with `workspace.delete` / `member.remove` on the owner).
- `admin` — all except `workspace.delete`.
- `developer` — `workspace.read, member.read, project.read, project.write, key.*,
  routing.read, routing.write, alias.*, request.read, analytics.read, usage.read,
  budget.read, limit.read, alert.*, webhook.*`.
- `billing` — `workspace.read, member.read, project.read, usage.read, analytics.read,
  billing.read, billing.write`.
- `viewer` — `workspace.read, member.read, project.read, key.read, routing.read, alias.read,
  request.read, analytics.read, usage.read, budget.read, limit.read, alert.read, webhook.read,
  billing.read`.
Platform-level caps (PRD §91 admin) stay in `lib/server/roles.ts`, untouched: workspace RBAC
gates `/dashboard/**`, platform caps gate `/admin/**`.

**Backfill:** every existing `user` gets workspace `<Name>'s Workspace` (slug deduped), a
project `<Name>'s Project`, the three default environments (`development`, `staging`,
`production`), an `owner` membership, and a `billing_account` with `amount_micro=0` opening
balance. Every existing `api_key` lands on that project's `production` environment.

---
## 3. API keys (PRD §25–26)
`api_key` evolves:
```
api_key (id, workspace_id, project_id, environment_id, user_id (creator, SET NULL),
         name, prefix unique, key_hash, status active|disabled|revoked,
         policy jsonb, expires_at timestamptz NULL,
         last_used_at, revoked_at, created_at, updated_at)
```
`policy` (jsonb; added in `0006` and backfilled in `0007` from the S0 `limits` values —
`{rpm, monthly_cost_micro}` → `{rpm, monthly_spend_micro}`). The legacy `api_key.limits`
column is dropped by the reserved `0012` final-wave drop (not yet authored; see the wave
list), after every reader migrates to `policy`:
```json
{ "endpoints": ["/v1/chat/completions"], "models": ["deepseek/deepseek-v4"],
  "aliases": ["production-chat"], "ip_allowlist": ["203.0.113.0/24"],
  "rpm": 600, "tpm": 1000000, "concurrency": 32,
  "daily_spend_micro": 5000000, "monthly_spend_micro": 100000000 }
```
Missing field = inherit (see §7). The secret is shown once at creation only; the wire format
`sk-ar-<prefix>_<secret>` and `sha256(secret)` storage are unchanged and must stay
byte-compatible between TS (`lib/server/keys.ts`) and Go (`internal/keys`).

---
## 4. Provider network (PRD §52–56)
```
provider   (id, name, slug unique, description, type, status
            operational|degraded|disabled|maintenance|outage,
            tier commercial|dev default 'commercial',
            homepage, documentation_url, enabled bool, priority int,
            created_at, updated_at)
connection (id, provider_id, name, slug, base_url, region, auth_type
            bearer|oauth|header|query, timeout_ms, priority, enabled bool,
            health_status healthy|degraded|unhealthy|unknown,
            config jsonb, created_at, updated_at; unique (provider_id, slug))
credential (id, connection_id, name, secret_enc, status
            healthy|rate_limited|cooldown|auth_failed|invalid|disabled|unknown,
            priority int, weight int, last_used_at, last_success_at, last_error_at,
            cooldown_until timestamptz NULL, metadata jsonb, created_at, updated_at)
```
- `provider.base_url` + `provider.credentials_enc` (S0) are **carried into
  connection/credential rows by the `0007` backfill and dropped by the reserved
  `0012` final-wave drop (not yet authored)** — both columns are still live until
  then: each S0 provider becomes one connection (`slug='default'`, `base_url` carried
  over, `auth_type` derived) and one credential per account in the decrypted blob
  (`accounts[]` → one row each; bare `api_key` → one row).
- `tier` carries S0's commercial gate forward: the data plane serves `tier='commercial'`
  rows always and `tier='dev'` rows only under `ROUTER_ALLOW_DEV_PROVIDERS` (S0 matched on
  `provider.status='dev'`, which the PRD §52 status set no longer contains).
- `connection.config` jsonb carries what used to live in the blob's shared fields:
  `{"protocol": "freebuff", "default_headers": {...}, "auth_kind": "..."}`.
- `credential.secret_enc` reuses the exact S0 envelope: base64(`iv[12] || ct || tag[16]`),
  AES-256-GCM, key `CREDENTIALS_MASTER_KEY` (packages shared: TS `lib/server/crypt.ts`, Go
  `internal/crypt`). Ciphertext content is **one account JSON** `{"email","access_token",
  "refresh_token","id_token","expired"}` or `{"api_key": "..."}`. Raw secrets never leave the
  backend, are never logged, never in audit diffs.
- OAuth refresh (the xAI-style refresher) persists rotated tokens back to the single
  credential row it belongs to (`secret_enc` rewrite), instead of rewriting a provider blob.

---
## 5. Canonical models, mappings, aliases (PRD §57–59, §35–36)
```
model        (id, name, slug unique, family, developer, description,
              modality jsonb, context int (= S0 `context`, kept; the PRD's
              `context_window` name is not worth a rename migration), max_output int,
              capabilities jsonb, status active|deprecated|sunset|disabled,
              created_at, updated_at)
provider_model (id, model_id → model, provider_id → provider,
              connection_id NULL → connection, provider_model_id text,
              enabled bool, capabilities_override jsonb, context_override int NULL,
              status available|degraded|unavailable|deprecated|disabled,
              created_at, updated_at; unique (model_id, provider_id, coalesce(connection_id,'')))
model_alias  (id, workspace_id NULL = global virtual, project_id NULL,
              name, description, enabled bool, created_at, updated_at)
model_alias_target (alias_id → model_alias, model_id → model, position int,
              primary key (alias_id, position))
```
- `model.slug` is what a customer sends as `model`. S0 rows are provider-scoped — each one
  becomes a canonical `model` **plus** one `provider_model` whose `provider_model_id` is the
  upstream model name, so existing slugs keep resolving.
- `capabilities` jsonb keys: `{"text","vision","audio","tools","reasoning","streaming",
  "structured_output","embeddings","json_mode"}`. Requests declare required capabilities;
  the router eliminates candidates whose override/canonical value is **explicitly `false`**
  (PRD §123–124). A missing/unknown key is not a claim — it passes the filter and loses to
  explicit `true` in scoring — so an unenriched catalog can never black-hole a request.
- Global virtual models (PRD §36) are `model_alias` rows with `workspace_id NULL` and names
  `fudrouter/auto|fast|cheap|balanced|reliable|reasoning|coding`; each row carries the
  human-readable intent in `description`. Their target sets are resolved by the router from
  the active strategy (not pinned model lists).
- Alias resolution order: project alias → workspace alias → global virtual → literal
  `model.slug`. First match wins.

---
## 6. Pricing (PRD §60–61)
```
pricing_rule (id, model_id, provider_model_id NULL, version int,
              currency char(3), input_price numeric(18,6), cached_input_price numeric(18,6),
              output_price numeric(18,6), reasoning_price numeric(18,6),
              effective_from timestamptz, effective_until timestamptz NULL,
              created_by NULL, created_at; unique (model_id, coalesce(provider_model_id,''), version))
```
Prices are **micro-units of currency per 1M tokens** (S0's `model.input_price` unit).
Updates never mutate history: the current row gets `effective_until = now()` and a new
version row is inserted. A request snapshots the prices it was billed at
(`request_log.pricing_rule_id` + `*_price_micro` columns) so historical cost never changes.
Where both `provider_model_id`-specific and model-wide rules exist, the specific one wins.
NULL semantics (PRD §122 distinguishes missing from zero): `cached_input_price` NULL = no
cached-input pricing offered → cached input tokens bill at `input_price`;
`reasoning_price` NULL → reasoning tokens bill at `output_price`.

---
## 7. Limits & budgets (PRD §40–41, §26)
```
rate_limit (id, scope workspace|project|environment|api_key, scope_id text,
            rpm int NULL, tpm bigint NULL, rpd int NULL, tpd bigint NULL,
            concurrency int NULL, daily_spend_micro bigint NULL,
            monthly_spend_micro bigint NULL, created_at, updated_at;
            unique (scope, scope_id))
budget     (id, scope workspace|project|environment, scope_id text,
            period daily|weekly|monthly, amount_micro bigint,
            warn_percent int default 70, critical_percent int default 90,
            action_at_100 notify|restrict|block, created_at, updated_at;
            unique (scope, scope_id, period))
```
Effective limit = **minimum** across the chain
platform default → workspace → project → environment → api_key
(PR §26: a specific level may tighten, never exceed the platform hard limit kept in
`system_setting`).
Budget enforcement: Valkey atomic counters on the fast path, durable aggregates in
PostgreSQL (`usage_daily`); counter loss must never make spending unbounded — the DB sum is
re-checked when a Valkey counter is missing.

---
## 8. Requests, attempts, usage (PRD §28–29, §61, §86–88, §96–97)
`request_log` keeps its name and append-only discipline. `user_id`/`api_key_id` stay
`ON DELETE SET NULL` (the ledger survives its subject). **Existing S0 column names stand**
(`tokens_in`, `tokens_out`, `cost` = customer charge); new columns use full names. State:
```
request_log (id req_, user_id, api_key_id, workspace_id (SET NULL), project_id (SET NULL),
             environment_id (SET NULL), endpoint text,
             requested_model text, model_id (resolved canonical, SET NULL — NULL = the
             request died before a model resolved, e.g. MODEL_NOT_FOUND), provider_model_id NULL,
             provider_id NULL, connection_id NULL, credential_id NULL,
             routing_policy_id NULL, strategy text,
             status success|client_error|provider_error|timeout|rate_limited|cancelled|internal_error,
             error_code text NULL, error text NULL, http_status int NULL,
             tokens_in bigint, cached_input_tokens bigint, tokens_out bigint,
             reasoning_tokens bigint, total_tokens bigint
                 (bigint NULL — NULL = provider did not report; 0 = reported zero, PRD §122),
             input_price_micro, cached_input_price_micro, output_price_micro,
             reasoning_price_micro (numeric(18,6) NULL), pricing_rule_id NULL,
             provider_cost_micro bigint, cost bigint (= customer charge),
             credit_charged_micro bigint,
             currency char(3), ttft_ms int NULL, latency_ms int, timing jsonb,
             attempts int default 1, fallback_used bool default false, stream bool default false,
             client_disconnected bool default false, client_ip inet NULL,
             request_body text NULL, response_body text NULL,
             created_at; indexes per PRD §149)
```
S0's `tokens_in`/`tokens_out` become `bigint` (were `integer`) and keep their names.
**`provider_model_id` is the `provider_model` ENTITY id (`pmdl_…`), not the upstream
model name** — consistent with `provider_id`/`connection_id`/`credential_id` on the same
rows and with `pricing_rule.provider_model_id`. The upstream model name is the
`provider_model.provider_model_id` field (and request_attempt `metadata` where already
captured). `timing` jsonb keys: `{"auth","rate_limit","routing","queue",
"connection","generation"}` ms. `request_body`/`response_body` are written **only** when the
retention policy allows content capture (PRD §93–94: metadata always, content opt-in).

```
request_attempt (id rta_, request_id → request_log, attempt int, provider_id, connection_id,
             credential_id NULL, provider_model_id NULL, http_status int NULL,
             error_code text NULL, retryable bool, latency_ms int, ttft_ms int NULL,
             provider_cost_micro bigint, reason text (why this candidate won),
             started_at, finished_at, metadata jsonb; unique (request_id, attempt))
```
Aggregates (PRD §96) — written by the rollup job, read by dashboards over long ranges:
```
usage_hourly (bucket_start timestamptz, workspace_id, project_id, environment_id,
             api_key_id, model_id, provider_id, connection_id, status, endpoint,
             requests, successes, tokens_in, cached_input_tokens, tokens_out,
             reasoning_tokens, total_tokens, cost_micro, latency_ms_sum,
             latency_histogram jsonb, ttft_ms_sum, fallback_count, retry_count,
             updated_at; unique on the coalesced dimension tuple)
usage_daily  (same shape, bucket_start = day start in UTC)
```
`latency_histogram` is a fixed bucket map `{"<ms>": count}` (buckets: 50,100,250,500,1000,
2500,5000,10000,25000,60000,inf) so p50/p95/p99 are estimable without raw rows.

**Error taxonomy** (PRD §88) — `error_code` values, exactly:
`AUTHENTICATION_ERROR, AUTHORIZATION_ERROR, RATE_LIMITED, INSUFFICIENT_CREDITS,
INVALID_REQUEST, MODEL_NOT_FOUND, CONTEXT_TOO_LONG, UNSUPPORTED_PARAMETER,
CONTENT_REJECTED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE, CIRCUIT_OPEN,
UPSTREAM_ERROR, INTERNAL_ERROR`.
Raw upstream error text goes in `error`/`metadata`, never as the client-facing code.

---
## 9. Routing (PRD §30–34, §63)
```
routing_policy (id rte_, workspace_id NULL, project_id NULL, environment_id NULL,
             name, strategy balanced|lowest_cost|lowest_latency|highest_reliability|
                        provider_priority|weighted|round_robin|random|smart,
             enabled bool, max_attempts int default 2, request_timeout_ms int default 30000,
             fallback_enabled bool default true,
             provider_preferences jsonb, model_preferences jsonb,
             constraints jsonb, weights jsonb, created_at, updated_at)
circuit_breaker (id cbr_, target provider|connection|model, target_id text,
             failure_threshold int, window_seconds int, open_ms int,
             half_open_probes int, enabled bool, created_at, updated_at;
             unique (target, target_id))
```
- `constraints` keys: `{"max_input_price_micro","max_output_price_micro","max_p95_latency_ms",
  "min_availability","allowed_providers","blocked_providers","region_preference"}`.
- `weights` keys for `balanced`: `{"price","latency","reliability","capacity"}` — the score
  formula is internal and may change without breaking the API (PRD §31).
- Resolution: environment → project → workspace → platform default
  (`system_setting['default_routing_policy']`). Defaults per PRD §139: `balanced`,
  `fallback_enabled=true`, `max_attempts=2`, `request_timeout_ms=30000`.
- Retry/fallback (PRD §33–34): retry on `RATE_LIMITED, PROVIDER_TIMEOUT,
  PROVIDER_UNAVAILABLE, CIRCUIT_OPEN, UPSTREAM_ERROR(5xx/429/401/403), transport errors`.
  Never on `INVALID_REQUEST, UNSUPPORTED_PARAMETER, CONTEXT_TOO_LONG, MODEL_NOT_FOUND,
  AUTHORIZATION_ERROR, CONTENT_REJECTED`. The overall `request_timeout_ms` is a **deadline**:
  the router never starts an attempt that cannot finish inside it.
- Circuit state lives in Valkey (`circuit:{target}:{id}` → `closed|open|half_open`), config in
  PostgreSQL. With Valkey down the breaker degrades to closed and health filtering carries
  the load (PRD §150).

---
## 10. Billing (PRD §47–48, §128–129)
```
billing_account (id bac_, workspace_id unique, currency char(3) default 'USD',
             status active|suspended|closed,
             warning_threshold_micro bigint default 10000000,
             hard_stop_threshold_micro bigint default 0,
             balance_micro bigint default 0 (cache; always reconcilable),
             created_at, updated_at)
credit_ledger (id txn_, billing_account_id, type credit_purchase|usage_charge|
             adjustment|refund|promotion|expiration,
             amount_micro bigint (signed), currency char(3), request_id NULL,
             idempotency_key text NULL unique, description text, metadata jsonb,
             created_by NULL, created_at)
invoice (id inv_, billing_account_id, number text unique, period_start, period_end,
             amount_micro bigint, currency, status draft|open|paid|void|uncollectible,
             issued_at NULL, paid_at NULL, created_at)
```
- Balance = `SUM(credit_ledger.amount_micro)`; `balance_micro` is a cache updated in the same
  transaction as the insert, never the only record.
- Per request (PRD §128, atomic): `request_log` row + one `usage_charge` ledger row in
  **one transaction**, amount = `customer_cost_micro`, `request_id` set,
  `idempotency_key = 'usage:' || request_id` so a retry can never double-charge.
- Low balance (PRD §129): below `warning_threshold_micro` → alert event; at/under
  `hard_stop_threshold_micro` → the router rejects with normalized `INSUFFICIENT_CREDITS`
  (HTTP 402).

---
## 11. Operations (PRD §42–43, §70–77, §104–105, §19)
```
alert        (id alr_, workspace_id NULL, project_id NULL, name,
              condition jsonb {"type","threshold","window_seconds"}, channel inapp|email|webhook,
              enabled bool, created_at, updated_at)
alert_event  (id ale_, alert_id, triggered_at, value numeric, message text,
              state firing|resolved, resolved_at NULL, delivered_at NULL)
webhook      (id whk_, workspace_id, project_id NULL, url, secret_enc NULL,
              events jsonb, enabled bool, created_at, updated_at)
webhook_delivery (id whd_, webhook_id, event text, payload jsonb,
              status pending|delivered|failed|cancelled, attempts int, max_attempts int,
              next_attempt_at, response_code int NULL, error text NULL,
              created_at, delivered_at NULL)
job          (id job_, type text, payload jsonb,
              status pending|running|completed|failed|cancelled,
              attempts int, max_attempts int, available_at, started_at NULL,
              finished_at NULL, error text NULL, created_at)
system_event (id evt_, type text, resource text, resource_id text, workspace_id NULL,
              metadata jsonb, created_at)
audit_log    (id aud_, actor_user_id NULL, actor_kind user|system|api_key, action text,
              resource text, resource_id text, workspace_id NULL, ip inet NULL,
              before jsonb, after jsonb, metadata jsonb, created_at)
incident     (id inc_, title, component text, severity minor|major|critical,
              status investigating|identified|monitoring|resolved,
              started_at, resolved_at NULL, created_at)
incident_update (id icu_, incident_id, status investigating|identified|monitoring|resolved,
              message text, created_at)
feature_flag (id flg_, name unique, description, enabled bool, rollout jsonb, updated_at)
security_rule (id rul_, name, kind, config jsonb, enabled bool, action log|block,
              created_at, updated_at)
system_setting (key text primary key, value jsonb, updated_by NULL, updated_at)
```
- `audit_log` is append-only in application code; secrets are never stored in
  `before`/`after` (redact at write, PRD §137).
- Jobs: PostgreSQL is the queue, workers claim with `FOR UPDATE SKIP LOCKED`; Valkey holds
  `lock:job:{id}` and wake-up hints only (PRD §75).
- Status page components (PRD §19) derive from `system_event` health snapshots +
  `incident` rows.

---
## 12. Valkey (PRD §82–84, §146, §150)
Valkey is a **cache/counter layer only**. Losing it must lose no business data. Namespaces
(exact strings — both planes MUST match):
```
rl:{scope}:{id}:rpm|tpm|rpd|tpd        rate-limit counters (Lua fixed-window)
conc:{scope}:{id}                      in-flight gauge
spend:{scope}:{id}:day|month           spend counters (micro-units)
usage:{project_id}:{minute}            short-term counters
health:provider:{id}  health:connection:{id}   rolling health snapshot (json)
credential:{id}:state                  transient credential state
circuit:{provider|connection|model}:{id}   closed|open|half_open
model:cache:{id}  catalog:cache        routing/catalog cache
session:{id}  idem:{key}  lock:job:{id}  metric:{...}
```
Clients: Go `internal/vk` (valkey-go, `github.com/valkey-io/valkey-go`), TS `lib/server/vk.ts`
(`ioredis` — Node 22 has no `node:valkey` builtin, verified 2026-09-30). Both wrap a
singleton, expose the few operations below, and **degrade open** on connection failure with
at most one warning log per minute:
```go
// Go — services/router/internal/vk
AllowRate(ctx, key string, limit int, window time.Duration) (ok bool, err error)
IncrConc(ctx, key string, ttl time.Duration) (int64, error); DecrConc(ctx, key string) error
GetJSON/SetJSON(ctx, key string, v any, ttl time.Duration) error
Lua(ctx, script, key string, args ...any) ([]any, error)
```
```
// TS — shared/control-lib/server/vk.ts
allowRate(key, limit, windowMs): Promise<boolean>
getJSON<T>(key): Promise<T | null>; setJSON(key, value, ttlMs): Promise<void>
incr(key, ttlMs): Promise<number>; decr(key): Promise<void>
```
Cache invalidation: every durable write bumps `ver:{table}` (INCR); cache entries embed the
version they were built at and are rebuilt lazily on mismatch. PostgreSQL is always
authoritative.

**Deployment:** Valkey is SHARED, host-native infra (systemd
`valkey-server.service`, 127.0.0.1:6379, protected-mode + requirepass) — the
same consolidation shape as the hardened Postgres. `infra/docker-compose.yml`
runs no Valkey container: a second instance would fight over the port and split
the keyspace. fudrouter uses **logical DB 1** of that instance so its keyspace
stays separate from other projects on the server. Both planes read `VALKEY_URL`
(e.g. `redis://:<password>@127.0.0.1:6379/1`); absent/`VALKEY_URL=""` disables
the client cleanly (the S0 in-process fallback stays). The endpoint is
configuration — **never hardcoded in app code**.
Go client module: `github.com/valkey-io/valkey-go`. TS client package: `ioredis`.

---
## 13. Module boundaries (PRD §113–115)
Go (services/router/internal/): `store` (all SQL), `ids`, `vk`, `cost`, `crypt`, `keys`,
`netguard`, `proxy` (http hot path), `routing` (candidate selection/scoring/fallback),
`upstream` (per-connection client, OAuth refresh), `limits`, `health`, `jobs` (workers).
TS (shared/control-lib/server/): `db` (drizzle), `auth`, `keys`, `crypt`, `vk`, `rbac`
(workspace permissions), `billing` (ledger), `audit`, `jobs`; the React app owns the
page-level routes and their server actions under `apps/react-web/`. Rule from S0 stands:
pure rule / env read / separate files.

**Migration tooling** — hand-written SQL in `infra/migrations/NNNN_*.sql`, applied in lexical
order by `scripts/migrate.sh` (psql, `ON_ERROR_STOP`, idempotent via a `schema_migration`
name table). Drizzle-kit's journal/snapshot pair is retired (`infra/migrations/meta/` removed,
`db:generate`/`db:check`/`db:push` retired with the Svelte app's `apps/web/package.json`):
the journal only
knew 0000–0003 while 0004/0005 shipped as plain SQL — `drizzle-kit migrate` silently skipped
them for the web plane (live evidence, 2026-09-30). `db/schema.ts` mirrors the SQL for typed
queries; the SQL files are the source of truth.

**Control-plane ↔ data-plane contract** (unchanged in shape): the router reads PostgreSQL
directly for keys, routing config, catalog and pricing; the control plane never proxies the
hot path. Management writes go: PostgreSQL → `ver:` bump → router cache TTL (≤30s) picks it
up.

---
## 14. Compatibility promises
1. Existing `sk-ar-` API keys keep working through the migration (prefix/hash format
   unchanged).
2. Existing `model.slug` values keep resolving to the same upstream model.
3. `request_log` rows written before the migration keep their cost/token history; S0
   `tokens_in/tokens_out/cost` map to `input_tokens/output_tokens/customer_cost_micro`.
4. `/v1/models` keeps listing published slugs with `{"id","object","owned_by"}` plus the
   additive fields `context`, `pricing`.
5. New endpoints (`GET /v1/models/{model}`, faithful generic forwarding) are additive.
   Unimplemented `/v1/*` paths return a truthful `404` error body (the endpoint-surface spec
   §8 open question is resolved: honesty wins — a valid key sees `404`, not `401`).

---
## 15. Non-goals for this schema
No partitioning yet (PRD §148 keeps `request_log` unpartitioned until volume demands it;
indexes match §149). No external vault, broker, or analytics store (PRD §5). No custom RBAC
tables beyond `workspace_role` (custom roles are rows, not schema).
