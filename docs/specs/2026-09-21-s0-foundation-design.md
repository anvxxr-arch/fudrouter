# S0 — Foundation (walking skeleton)

**Date:** 2026-09-21
**Status:** Draft — awaiting review
**Sub-project:** S0 of 7 (see Decomposition)
**Supersedes:** `fudrouter-app` (the personal MITM router) — see Decommission

---

## 1. Context

`fudrouter` is becoming a **commercial AI router**: one API key for many model
providers, intelligent routing with fallbacks, real-time usage/credit tracking,
and programs (free credit, coding plan, bansos, referral).

Two decisions frame everything below:

1. **Provider economics — legitimate resale.** The router buys model access
   through commercial API keys ([OI], Anthropic, Gemini, OpenRouter…) and
   resells with margin. It does **not** route through personal OAuth sessions or
   MITM'd IDE traffic. The current `fudrouter-app` does exactly that (9 personal
   `opencode-zen` accounts + MITM hijack of Copilot/Kiro/Cursor/Antigravity), so
   its provider layer is unusable for this product and must not ship.

2. **Architecture B — split control plane and data plane.**
   - **Control plane:** SvelteKit + TypeScript. UI, auth, billing, admin.
   - **Data plane:** Go. The `/v1/chat/completions` hot path.
   Rationale: the existing Go core is already provider-agnostic and makes plain
   `POST {base}/v1/chat/completions` calls, while Node is the weaker tool for a
   latency-sensitive streaming proxy.

### Reuse assessment (measured, not assumed)

| Package | LOC | Verdict |
|---|---:|---|
| `provider` | 823 | ✅ generic — depends only on `catalog`, `db` |
| `chat` | 340 | ✅ generic |
| `circuit` | 315 | ✅ generic |
| `cache` | 185 | ✅ generic |
| `coalesce` | 66 | ✅ generic |
| `metrics` | 266 | ✅ generic |
| `tracing` | 172 | ✅ generic |
| `catalog` | 176 | ✅ generic (JSON file → Postgres) |
| **subtotal** | **~2,343** | **lift** |
| `mitm` | 475 | ❌ personal IDE hijack |
| `oauth` | 1,848 | ❌ personal OAuth sessions |
| `protocol` | 1,380 | ❌ MITM protocol shims (Kiro/Cursor/Codex) |
| **subtotal** | **~3,703** | **retire** |

Only real coupling in the reusable set is `db` (SQLite) and `catalog` (JSON),
both replaced here.

---

## 2. Decomposition

Seven sub-projects, each with its own spec → plan → build cycle.

| # | Slice | Depends on |
|---|---|---|
| **S0** | **Foundation** — repo, schema, auth/RBAC, API keys, decommission, walking skeleton | — |
| S1 | Router data plane — providers, models, routing, streaming, rate limits, quota, request log | S0 |
| S2 | Billing & credits — ledger, cost attribution, transactions, top-ups, invoices, payments | S1 |
| S3 | Programs — free credit, coding plan, bansos, referral | S2 |
| S4 | Client dashboard — 14 user pages | S1–S3 |
| S5 | Admin panel — 40+ admin pages, audit log | S1–S4 |
| S6 | Ops & resources — logs, queues, incidents, flags, status, webhooks | S1–S5 |

Ordering: S0 unblocks all → S1 produces the product → S2 makes money real →
S3 growth → S4/S5 expose it → S6 hardens. UI deliberately follows billing, so
dashboards are not built twice.

---

## 3. S0 Scope

### In scope
- Monorepo, dev environment, CI
- Postgres schema (9 tables: 4 Better Auth + 5 application) + Drizzle migrations
- Auth (Better Auth), sessions, RBAC (4 roles)
- API key issue / hash / revoke
- Minimal provider + model seed
- One end-to-end path: key → `/v1/chat/completions` → upstream → stream → logged
- Minimal usage page (SSR from Postgres)
- **Decommission of `fudrouter-app`**

### Out of scope
- Billing, credits, ledger, payments (S2)
- Programs: free credit, coding plan, bansos, referral (S3)
- Full client dashboard and admin panel (S4/S5)
- Ops surface: queues, incidents, flags, status page (S6)
- Team/org accounts — single-user tenancy in S0
- MITM, OAuth-per-provider, IDE protocol shims — retired permanently

---

## 4. Decommission of `fudrouter-app`

The new product takes the `fudrouter` name, ports, and eventually the tunnel.
The old service must be retired **cleanly**, because a partial teardown leaves
the machine broken in a way that looks like a network problem.

### 4.1 Hazard

`/etc/hosts` currently contains 8 entries pointing IDE domains at `127.0.0.1`:

```
daily-cloudcode-pa.googleapis.com      cloudcode-pa.googleapis.com
api.individual.githubcopilot.com       runtime.us-east-1.kiro.dev
api2.cursor.sh                         api3.cursor.sh
agent.api5.cursor.sh                   agentn.api5.cursor.sh
```

If the MITM on `:443` stops while these remain, the hostnames resolve to
localhost with nothing listening — Copilot, Kiro, Cursor and Antigravity stop
working entirely. **Removing these entries is part of decommissioning, not an
afterthought.**

### 4.2 Accepted consequence

Personal IDE routing is unavailable until the new product is functional. This is
a deliberate, accepted trade-off.

### 4.3 Steps (in order)

**Phase A — backup (the reversible point)**

1. Archive `fudrouter-app` (including `.git`) and `~/.fudrouter/db/data.sqlite`
   to a timestamped tarball outside the repo.
2. Copy `/etc/hosts` to `/etc/hosts.pre-decommission`.

**Phase B — service teardown** (personal IDE routing goes dark here)

3. Stop and delete the PM2 process `fudrouter`.
4. Remove the 8 MITM entries from `/etc/hosts`.
5. Confirm ports `8011`, `8012`, `443` are free.
6. Remove **only** the `ai.karepmuwes.my.id` ingress rule from
   `~/.cloudflared/config.yml`. **Do not delete the tunnel** — `39bdfeef-…` is
   shared, and its `zura.dwirijal.my.id` → `:8084` rule serves the Zura storage
   pool. Deleting the tunnel takes Zura down with it.
7. Remove `cap_net_bind_service` from the retired binary.

**Phase C — lift, then delete**

8. Lift the ~2,343 LOC core into `services/router/` and verify the new service
   runs against it.
9. **Only then** delete `fudrouter-app`. Deleting it earlier destroys the source
   being migrated. The Phase A tarball remains the recovery path.

### 4.4 Rollback

- **Before step 9:** restore `/etc/hosts.pre-decommission`, re-add the PM2
  process from `ecosystem.fudrouter-go.config.cjs`, re-apply `setcap`.
- **After step 9:** restore from the Phase A tarball.

---

## 5. Repository layout

Monorepo, npm workspaces — the same shape as the existing `fudcourt` monorepo.

```
fudrouter/
  apps/web/                 # SvelteKit control plane — adapter-node     :3000
  services/router/          # Go data plane (lifted core)                :8100
  packages/contracts/       # shared TS types for web ↔ router contract
  infra/                    # docker-compose (PG17 + Valkey), migrations
  docs/specs/               # this document
```

Home: `/home/dwizzy/fudrouter`.

---

## 6. Dev environment

`docker compose` providing:

| Service | Image | Host port |
|---|---|---|
| Postgres | `postgres:17` | `5434` |
| Valkey | `valkey/valkey:8` | `6379` |

**Deliberately not reusing the native PG17 cluster on `:5433`.** That cluster is
peer-auth, unix-socket-only, and owns the `cfmanager` database. The product needs
its own role, its own backup boundary, and a configuration that ports to
production unchanged. (`:5432` is also occupied.)

Valkey runs from day one but is **unused in S0** — rate limiting stays in-process
until S2 needs queues.

### Ports

`3000` (web) and `8100` (router) are free. Occupied on this host: `22 53 139 443
445 5432 5433 8011 8012 8080 8091 8092 9177 20241`.

---

## 7. Data model

S0 creates **9 tables** — 4 managed by Better Auth, 5 application tables. The
PRD's §8 lists 14; the remainder belong to S2/S3/S5 and are deferred rather than
guessed.

### Better Auth (generated by its CLI, extended)

```
user          id, email, emailVerified, name, image, role, banned,
              banReason, banExpires, createdAt, updatedAt
session       id, userId, token, expiresAt, ipAddress, userAgent, impersonatedBy
account       id, userId, providerId, accountId, password, accessToken…
verification  id, identifier, value, expiresAt
```

### Application

```
profile       userId PK→user, avatar, timezone, preferences jsonb
api_key       id, userId, name, prefix, keyHash, limits jsonb,
              lastUsedAt, revokedAt, createdAt
provider      id, name, baseUrl, credentialsEnc, status, priority
model         id, providerId, name, slug, context, inputPrice, outputPrice, status
request_log   id, userId, apiKeyId, modelId, providerId, tokensIn, tokensOut,
              cost, latencyMs, status, error, createdAt
```

### Rules

- **Money is never a float.** Prices `numeric(12,6)`; amounts `bigint` minor
  units; every monetary row carries a `currency` column. Multi-currency capable,
  **IDR + USD seeded**.
- **IDs:** UUIDv7 where time-ordering helps index locality.
- **Migrations:** Drizzle Kit, SQL files checked into `infra/migrations`, applied
  on deploy. Never `drizzle-kit push` against production.
- `request_log` is append-only and the highest-volume table; index on
  `(userId, createdAt)` and `(apiKeyId, createdAt)`.

---

## 8. Auth & RBAC

**Better Auth**, self-hosted — we own the user data. (Lucia is deprecated as of
March 2025 and is no longer an option.)

- Official SvelteKit integration: `better-auth/svelte-kit` handler +
  `sveltekitCookies` plugin (requires SvelteKit ≥ 2.20).
- `@better-auth/drizzle-adapter` for Postgres.
- **Admin plugin** supplies `role`, `banned`, `banReason`, `banExpires`,
  `impersonatedBy` — covering §6.2's "ban, impersonate" without hand-rolling.

### Roles

| Role | Scope |
|---|---|
| `user` | own keys, own usage, own billing |
| `admin` | all users, programs, router config |
| `finance_admin` | transactions, top-ups, refunds, pricing |
| `ops_admin` | provider health, routes, incidents, logs |

Enforced in `hooks.server.ts` for route groups, and **independently re-enforced
in the Go data plane** for `/v1/*`. The control plane is not a security boundary
for the hot path.

---

## 9. API keys

Format: `sk-ar-<prefix>_<secret>`

- Store **SHA-256(secret)** and the plaintext `prefix` only. Never the key, no
  reversibility.
- `prefix` is indexed for lookup; the hash is compared in constant time.
- Shown **once** at creation; unrecoverable afterwards.
- `limits` jsonb holds per-key model and IP restrictions (§6.1).
- `revokedAt` is a soft revoke; validation rejects revoked keys.

### Hot-path validation

The Go data plane reads `api_key` **directly from Postgres**, caching
`prefix → (userId, keyHash, limits)` in-process with a short TTL; revoke
invalidates the cache. One less network hop on the path that must hold §7's
`<50ms` overhead. Fallback if a single DB-access service is preferred: an
internal endpoint on the web app.

---

## 10. Provider credentials

`provider.credentialsEnc` is **AES-256-GCM**, master key from environment — the
same scheme already running in the Zura storage pool. Plaintext credentials are
never returned by any API, never logged, and never included in error responses.

---

## 11. Walking skeleton

The single path that defines S0 done:

```
signup / login (Better Auth)
  → create API key (displayed once)
  → curl POST :8100/v1/chat/completions  Authorization: Bearer sk-ar-…
  → Go validates key hash in Postgres (cached)
  → Go selects provider + model, calls upstream, streams SSE back
  → Go writes request_log (userId, apiKeyId, modelId, providerId,
                          tokensIn, tokensOut, cost, latencyMs, status)
  → SvelteKit page lists that request, SSR from Postgres
```

This proves SvelteKit ↔ Go ↔ Postgres ↔ upstream are genuinely wired.

---

## 12. Testing

- **Go unit tests (TDD)** for key validation, cost calculation, route selection —
  the places where a bug costs money or leaks access.
- **Vitest** for web server-side logic.
- **One end-to-end smoke test** running the whole path against the dev stack.
  This test *is* the S0 acceptance gate.
- CI: `sv check`, `drizzle-kit check`, `go vet ./...`, `go test ./...`.

---

## 13. Deploy

- `docker compose` (same file dev and prod) for Postgres + Valkey.
- SvelteKit via adapter-node under PM2 as **`fudrouter-web`**.
- Go data plane under PM2 as **`fudrouter-router`**.
- Drizzle migrations applied on deploy.
- **No public exposure during S0** — no tunnel ingress, no external ingress.

---

## 14. Acceptance criteria

S0 is done when all hold:

- [ ] `docker compose up` yields Postgres 17 + Valkey
- [ ] `sv check`, `go vet ./...`, `go test ./...` all green
- [ ] signup → login → create API key works
- [ ] `curl` to `/v1/chat/completions` with that key returns a real completion
      from one seeded provider
- [ ] a `request_log` row lands with correct `userId`, `apiKeyId`, `tokensIn`,
      `tokensOut`, `cost`
- [ ] the usage page renders that row from Postgres
- [ ] a revoked key returns `401`
- [ ] `fudrouter-app` decommissioned per §4 — service stopped, `/etc/hosts`
      cleaned, ports free, `ai.karepmuwes.my.id` ingress removed, repo deleted
      **after** the lift is verified, backup tarball retained

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Decommission breaks IDE tooling silently | Clean `/etc/hosts` as an explicit step (§4.3); back up before |
| Port/name collision with the live service | Decommission completes before the new services bind (§4.3) |
| Provider credentials leak | AES-256-GCM at rest, never serialized, never logged |
| Billing rounding errors | No floats; `numeric(12,6)` + minor units |
| Hot path slows once it is shared | Keep rate limiting in-process for S0; revisit with Valkey at S2 |
| Retrofitting orgs later is expensive | Accepted: single-user tenancy for v1 |

---

## 16. Open questions

1. **Production host** — the homeserver is fine for development; §7 targets
   99.9% uptime, which implies real hosting before public launch. Not blocking S0.
2. **Payment provider** — Stripe vs Midtrans/Xendit. Needed by S2, not S0.
3. **First providers to seed** — needed by S1.
4. ~~Tunnel disposition~~ — **resolved:** remove only the `ai.karepmuwes.my.id`
   ingress rule; the tunnel itself stays, because Zura depends on it (§4.3).
