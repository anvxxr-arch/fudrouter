# ADR-0007 — Dual billing: subscription plans + pay-as-you-go (PROPOSED)

- **Status:** PROPOSED — awaiting owner decision.
- **Date:** 2026-10-13
- **Deciders:** Dwi (owner)

## Context

Owner directive (2026-10-13): fudrouter implements two billing models:

| Model | Terms |
|-------|-------|
| Subscription 1 day | 5,000 |
| Subscription 3 days | 10,000 |
| Subscription 7 days | 15,000 |
| Subscription 30 days | 40,000 |
| Pay-as-you-go | per-token metering via `credit_ledger` (existing) |

Verified gap: zero subscription/plan code exists anywhere — no `subscription` table, no plan definitions, no renewal/expiry logic, no UI. `Pricing.tsx` and `public.mjs` contain no day/month/plan concepts. The existing ledger (`billing.ts` `LedgerType`, `credit_ledger_type_check` in `0006_platform_schema.sql`) hard-codes six types: `credit_purchase`, `usage_charge`, `adjustment`, `refund`, `promotion`, `expiration`.

**Open question for owner:** Currency of plan prices (5,000–40,000) — IDR or another unit? The ledger stores micro-units of the account currency (`billing_account.currency`); plan purchase posts in the account's currency. No float, no conversion in the ledger — same rule as today.

## Decision (proposed)

1. **Model subscriptions on the existing ledger, no new table.** A subscription purchase is a `credit_purchase` of N micro-credits with `metadata.plan` ∈ {`sub-1d`, `sub-3d`, `sub-7d`, `sub-30d`} and `metadata.expires_at`; plan end is an `expiration` posting. This reuses the single money funnel (`postLedger` + `reconcileAll` + `invoice_generation`) instead of creating a parallel billing path. The discriminator is `metadata.plan` — **no schema change**, no CHECK widening, no migration 0018.

2. **Entitlement = ledger balance; expiry enforced by `expiration` posting + `reconcileAll`, NOT by `checkBudgets`.** The data plane's `checkBudgets` (402 `INSUFFICIENT_CREDITS`, `budget.go:42-49`) gates on `acct.BalanceMicro` and `acct.Status` only — it reads NO expiry field, and `BalanceMicro` is the cached ledger sum. An expired plan's credits remain spendable until an `expiration` posting lands, `reconcileAll` rebuilds the cache, and the next request hits `checkBudgets`. This is a lag of at least one job cadence (hourly for `reconcileAll`). The owner must accept this enforcement lag as the trade-off for zero schema change.

3. **No new top-level layout.** Plan definitions live in `packages/platform/` (shared rule, unit-testable) + `server/publish-env.ts` split per convention; UI in existing `apps/web/src/routes/` billing pages. No new `apps/*`, no new `packages/*`, no new Go surface — so `ops/verify/structure.sh` and the contracts gate are unaffected.

4. **Currency.** Plan prices (5,000–40,000) — currency is an open question for the owner (see Context). The ledger stores micro-units of the account currency (`billing_account.currency`); plan purchase posts in the account's currency. No float, no conversion in the ledger — same rule as today.

## Consequences

- Positive: one money funnel, one reconciliation path, one invoice path. Subscription expiry is a ledger posting, so `reconcileAll` and the admin analytics rollups need no changes.
- Negative: plan pricing (fixed amounts) and PAYG pricing (per-token micro-USD) are different units in the same ledger — the UI must never sum them without currency awareness. `Pricing.tsx` must show the two models as separate sections (same rule as DESIGN.md §"A per-token price list shows the PAYG surface only").
- Negative: **enforcement lag** — an expired/cancelled plan keeps serving traffic until the `expiration` posting lands, `reconcileAll` rebuilds the cache, and the next request is rejected. The lag is at least one `reconcileAll` cadence (hourly). The owner must accept this window.

## Alternatives rejected

- **Seventh ledger type `subscription` + CHECK widening.** A new `subscription` type in `credit_ledger_type_check` would require migration 0018 + the same-writer sweep as migration 0010 — a schema change with a coordinated writer deploy, for no functional gain over `metadata.plan`. Rejected: the ledger already models time-boxed credit via `expiration` + `metadata.plan`.
- **Separate `subscription` table + renewal job.** Cleaner expiry semantics, but a second billing path with its own reconciliation, its own invoice logic, and a new job type — exactly the parallel-surface problem ADR-0006 rule 3 forbids without real code. Rejected: the ledger already models time-boxed credit via `expiration`.
- **Hard-coding plan prices in the SPA.** Prices are server state (they gate `checkBudgets`); the SPA renders what the server returns. Rejected per the console-is-not-a-security-boundary rule.

## Evidence

- Owner directive 2026-10-13 (subscription terms + PAYG).
- `packages/platform/server/billing.ts` `LedgerType` (six types); `0006_platform_schema.sql` `credit_ledger_type_check`; `packages/platform/server/workers.ts` `invoiceGeneration`; `backend/go/internal/proxy/billing.go` cost funnel; `backend/go/internal/proxy/budget.go` `checkBudgets` (lines 29-84).