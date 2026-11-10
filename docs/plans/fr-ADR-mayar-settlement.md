# ADR — Mayar settlement: hint-only webhook + server-side re-fetch (no-auth by design)

- **Status:** ACCEPTED (additive, G6-gated before revenue)
- **Date:** 2026-11-10
- **Branch:** `feat/mayar-gateway`
- **Deciders:** Dwi (owner), tech lead

## Context

Mayar's webhook carries no documented HMAC/signature and its body vocabulary is
contradictory (bool `status` vs string "SUCCESS" — `docs/plans/fr-mayar-plan-judge.md`
blockers B1/B2). The webhook is therefore a HINT ONLY: it can at most point at a
transaction. Every money decision is re-derived server-side and bound to what WE
persisted at create — never to anything the webhook claims.

## Decision

### 1. Webhook is hint-only, no-auth by design

[F] The transport trusts exactly two fields — `data.transactionId` ?? `data.id`
(`apps/web/server/mayar-webhook.mjs` `hintedIdOf`; test pinned at
`apps/web/server/mayar-webhook.test.mjs:93-100`). Amount and status are never
read from the body.

[F] The authoritative step is a server-side `GET /hl/v2/transactions/{hintedId}`,
then a three-part verdict in `settlementVerdict`
(`packages/platform/server/mayar-settlement.ts:111-133`):

1. `fetched.id === facts.transactionId` — bind to OUR persisted
   `payment.raw.mayar.transactionId` (refused as `raw_id_mismatch` at `:125`),
   never the webhook's id;
2. `fetched.status === 'paid'` (`MAYAR_PAID_STATUS`, `:29`; refused as
   `not_paid` at `:127-128`);
3. `Number(tx.amount) === facts.amountIdr` — integer IDR, refused as
   `amount_mismatch` at `:131`.

Only then does `runMayarSettlement` (`:183`) hand the verified facts to
`confirmAndGrant`. The webhook route file contains NO grant rule of its own
(`apps/web/server/mayar-webhook.mjs` header, `:1-23`).

### 2. Re-fetch amplification — recorded risk

[A] Each inbound webhook delivery triggers one outbound authenticated Mayar GET.
Because the route is unauthenticated, a third party can fire cheap inbound
requests to drive outbound re-fetches against our Mayar API key. This is an
amplification surface, not a money-mint surface: the re-fetch is a read-only GET
and can never grant on its own.

[F] Recorded mitigations (see §4–§5): per-IP rate limit, default OFF, and an
idempotent read-only re-fetch.

### 3. Hardening decision: stay no-auth (guarded) vs HMAC/allow-list (future)

**Decision: ship no-auth, guarded.** [F] Mayar documents no HMAC today and offers
no stable allow-list egress contract; money never moves from the webhook alone
(the verdict gate in §1 is the re-fetch binding). Guardrails that keep this
honest: (a) default OFF, (b) per-IP rate limit, (c) the reconcile backstop
(`reconcileMayarPayments`, `mayar-settlement.ts:266`) so a missed webhook still
settles, (d) idempotent re-fetch.

**Future hardening (honest recommendation):** add HMAC-signature verification
and/or an IP allow-list BEFORE enabling `MAYAR_WEBHOOK_ENABLED` in production if
any of: (i) Mayar documents a signature; (ii) re-fetch abuse or forged-hint
traffic is observed; (iii) the route must be internet-reachable without a
trusted-only reverse-proxy whitelist. The existing HMAC+anti-replay pattern to
copy is `packages/platform/server/webhooks.ts` (`SIGNATURE_HEADER` `:156`;
`signBody` `:251`).

### 4. Middleware order (fixed by T8)

[F] TARGET (mandate #8 TL — before: `enabled()` was checked INSIDE the handler
after `express.raw` + `ipLimit`, `apps/web/server/mayar-webhook.mjs:114-129`):

1. `enabled()` gate (404 when off) — FIRST middleware, before any rate limiter,
   so an OFF deployment consumes no limiter bucket and parses no body;
2. rate-limit (`ipLimit`) — BEFORE `express.raw`, so a 64KB body flood is
   throttled before it is ever parsed;
3. `express.raw({ limit: '64kb' })` — only after both gates pass.

[F] Fail-closed is preserved: default OFF → 404 without limiter consumption;
`MAYAR_API_KEY` unset → client null → still 404 (`mayar.ts:448-465`). The test
seams `ctx.enabled` / `ctx.ipLimit` / `ctx.settle` stay injected so the existing
transport tests keep passing (`apps/web/server/mayar-webhook.test.mjs`).

### 5. Default OFF

[F] `MAYAR_WEBHOOK_ENABLED` is OFF by default: `mayarWebhookEnabled()` returns
`env[MAYAR_WEBHOOK_ENABLED_ENV] === 'true'`
(`packages/platform/server/mayar.ts:71-73`; env name at `:39`). The API key is
the fail-closed switch: `mayarApiKey` → `null` when empty (`:59-63`), and
`mayarClientFromEnv` returns `null` (or throws `MayarConfigError` on a
sandbox/prod key-base mix) rather than ever opening the path (`:448-465`).

### 6. Anti-double-money (one payment → one subscription)

[F] `confirmAndGrant` runs the grant rule FIRST, before any write
(`packages/platform/server/payment-confirm.ts:119,134-135`); there is NO
`credit_purchase` ledger posting for these time plans (header `:10-22` — a flat
`frsubs` window; a `credit_purchase` would mint a phantom prepaid balance).

[F] The payment confirm is an idempotent compare-and-swap
`status <> 'confirmed'` (`payment-confirm.ts:186-195`): a replayed settlement
flips the SAME row once and reports `alreadyConfirmed`.

[F] Migration `0038_subscription_payment_id_uniq.sql` adds a partial UNIQUE
index on `subscription(payment_id) WHERE payment_id IS NOT NULL` — the durable
stopper against two concurrent callbacks minting two windows.

## G6 (live-binding gate) — status: MERAH

[F] G6 cannot yet be exercised: no sandbox Mayar credential is present to call
the live sandbox API.

[A] UNVERIFIED until G6 live — the end-to-end binding
`create.transactionId == getTransaction(id).id` on the real sandbox.

[A] UNVERIFIED — `amount` as integer IDR and `status=paid` as observed in a live
sandbox `GET /transactions/{id}`.

[A] UNVERIFIED — `POST /hl/v2/payments/simulate` request/response body (the
sandbox "force paid" step named in `docs/plans/fr-mayar-plan.md:54` and
`docs/plans/fr-mayar-plan-judge.md:29`).

[A] DECLARED CODE PATH — until G6 is green, the webhook re-fetch + verdict
binding is dead code by decision (default OFF; no live proof). Shipping it
additive does NOT flip revenue; `MAYAR_WEBHOOK_ENABLED` stays unset.

## Consequences

- Positive: money decisions have one source of truth (`resolveGrant` reached
  through `confirmAndGrant`), one idempotency namespace, one verification
  order; the webhook remains a harmless hint.
- Positive: additive and fail-closed (default OFF); no existing payment/
  settlement path changes.
- Negative/Recorded: the no-auth webhook is an amplification surface (§2);
  the G6 binding is unproven on a live sandbox, so this is not revenue-ready.

## Evidence (path:line)

- `apps/web/server/mayar-webhook.mjs` — `hintedIdOf`, route + seams, 404 gate
  (`:114-129` pre-T8; header `:1-23`).
- `packages/platform/server/mayar-settlement.ts` — `MAYAR_PAID_STATUS:29`,
  `settlementVerdict:111-133`, `runMayarSettlement:183`,
  `reconcileMayarPayments:266`.
- `packages/platform/server/mayar.ts` — `MAYAR_WEBHOOK_ENABLED_ENV:39`,
  `mayarApiKey:59-63`, `mayarWebhookEnabled:71-73`, `mayarClientFromEnv:448-465`.
- `packages/platform/server/payment-confirm.ts` — no `credit_purchase`:10-22,
  rule-first `confirmAndGrant:119,134-135`, CAS confirm `:186-195`.
- `backend/go/migrations/0038_subscription_payment_id_uniq.sql` — one-window
  unique index.
- `packages/platform/server/webhooks.ts` — HMAC reference `:156,251`.
- `packages/platform/test/mayar-settlement.test.mjs` — five-case + replay +
  reconcile + `raw_id_mismatch`/`no_transaction_id` proofs.
- `docs/plans/fr-mayar-plan-judge.md` — blockers B1/B2 (hint-only, echo
  UNVERIFIED, simulate).
