# ADR-0008 — Payment gateway interface first, vendor later

- **Status:** PROPOSED — awaiting tech-lead/owner decision.
- **Date:** 2026-11-09
- **Deciders:** Dwi (owner), tech lead

## Context

Members buy TIME (1d/3d/7d/14d/28d in IDR), not tokens, and settlement is
manual per the owner directive (rules 20, 21): a QRIS dynamic payment whose
proof an operator confirms. Releasing that into code means a payment gateway
will eventually sit on the money path — the piece of the platform where a bug
either gives away the product or takes money without delivering.

Two facts from the repository shape the decision:

1. **No gateway exists today.** `packages/platform/server/payments.ts` already
   owns the frozen plan table, the QRIS payload builder (`qrisFor`, tag 54 +
   CRC-16) and the grant rule (`resolveGrant`). There is no vendor adapter, no
   inbound webhook receiver, no `payment`-row writer yet. `payment` and
   `subscription` exist only as migration 0025 DDL, `payment` at 0 rows.
2. **The money path already has one source of truth per concern.** The plan
   price lives in `PLANS` (not a DB row, migration 0025 CHECK as backstop); the
   grant rule is `resolveGrant` (pure, four-case tested in
   `packages/platform/test/payments.test.mjs`); the manual top-up ceiling and
   idempotency namespace live in `add-credit.ts`, and migration 0036 already
   freed the `purchase:` idempotency namespace for the gateway (FR-revised §S5).

A vendor adapter written first would invent a second rule for amount-vs-plan,
plan existence and status, and drift from `resolveGrant` the moment either
changes. A vendor adapter written second has a contract to implement.

## Decision

1. **Define the interface before selecting a vendor.** `gateway.ts` is the
   contract: three operations, nothing vendor-specific in them.

   ```ts
   createPayment(ctx, input) -> { gatewayRef, qr, record, state }
   verifyCallback(ctx, rawBody, headers) -> { ok, gatewayRef, amountIdr, paymentRef } | { ok:false, reason }
   confirmPayment(ctx, gatewayRef, amountIdr) -> { grantInput } | { ok:false, reason }
   ```

   The default vendor vocabulary is deliberately minimal — `code === 'OK'`,
   `amount`, `ref` — so a concrete adapter (Midtrans, Xendit, native QRIS API)
   translates its envelope into this shape and no further.

2. **`confirmPayment` is a bridge, not a second rule.** It MUST call
   `resolveGrant` from `payments.ts`. It looks the payment up by our
   `gatewayRef`, asserts the callback settled, and forwards
   `{ plan, status: 'confirmed', amountIdr }` into `resolveGrant`. Unknown plan,
   amount mismatch and status are all decided there, once — so the gateway
   inherits any future change to the grant rule (criterion #4).

3. **Idempotency is durable and owned by us, not by the vendor.** `createPayment`
   derives `gatewayRef = purchase:<idempotencyKey>` deterministically, and the
   store's UNIQUE `(gateway, gateway_ref)` index (migration 0025) is the
   stopper: a retried create returns the existing row with `state: 'existing'`.
   This is the same durable-idempotency pattern the ledger already uses for
   `usage:` and `admin_credit:` keys.

4. **The inbound callback verifies before it grants, always.** `verifyCallback`
   enforces, in order: (a) parse; (b) HMAC-SHA256 over the *exact raw body*
   compared in constant time — an unsigned/forged body stops before any nonce,
   so a signature flood cannot exhaust the replay table; (c) a bounded replay
   window; (d) a nonce claim — the second delivery of the same nonce is refused,
   "no double grant"; (e) an SSRF outbound guard, but only when the gateway
   carries a `verify_url` that needs a validation call-back (native QRIS manual
   confirm does not, and the guard is injected, never fetched here).

5. **Vendor selection is deferred and gated on the same contract.** The concrete
   vendor adapter is a separate task; it implements `gateway.ts` or it is
   rejected.

## Consequences

- Positive: the money path has a single grant rule, a single idempotency
  namespace, and a single verification order, pinned by a pure test
  (`packages/platform/test/gateway.test.mjs`) before any vendor exists.
- Positive: swapping vendors is an adapter, not a rewrite of the grant/verify
  logic — the risk of the eventual Midtrans/Xendit/QRS-native decision is
  contained behind one interface.
- Negative: the interface cannot ship revenue by itself. Until the vendor
  adapter (B3a) and the grant writer (B2) land, `createPayment`/`verifyCallback`
  /`confirmPayment` are contract + tests, not a live webhook.
- Neutral: the default vendor name `qris-native` is a placeholder, not a
  commitment; selecting a vendor only changes `GATEWAY_DEFAULT` and adds an
  adapter, never this module's shape.

## Vendor candidates (NOT selected)

The decision "which vendor" is explicitly open. Candidates and the selection
criteria that will close it:

| Candidate | Notes | Fits manual-confirm QRIS? |
|-----------|-------|---------------------------|
| Native QRIS (`qris-native`) | The owner's already-pinned merchant payload in `payments.ts` (`COM.GO-JEK.WWW`, tag 54 injection). No third party, manual operator confirmation (rules 20–21). | Yes — this is literally the current model. |
| Midtrans QRIS | Managed settlement callback, sandbox to production. Adds a vendor HMAC key and a webhook contract. | Yes — but the callback (not the operator) reports settlement. |
| Xendit QRIS | Same shape as Midtrans; different callback envelope. | Yes — with an adapter. |

Selection criteria (in priority order):

1. **Manual-confirm QRIS is supported** — the owner priced time and settled
   manually; a gateway that insists on auto-settlement changes the product.
2. **Callback carries a stable, unique reference we minted** — idempotency is
   our `purchase:` ref, not the vendor's; a vendor that cannot echo our ref is
   disqualified.
3. **HMAC-signed callback with a replayable nonce/timestamp** — the verification
   order above must map onto the vendor's envelope without reducing it.
4. **IDR settlement in whole-rupiah integers** — no decimal, no float, matching
   `resolveGrant` and `qrisFor`.
5. **No outbound validation call** (or, if one exists, it is a public HTTPS URL
   that passes `assertPublicUpstream`) — the SSRF guard is not optional.

No vendor is selected by this ADR; the interface commits to none.

## Alternatives rejected

- **Write the vendor adapter first (Midtrans/Xendit) and let it encode the
  rules.** Duplicates `resolveGrant`'s plan/amount/status logic; a later vendor
  swap re-audits money code instead of replacing an adapter; violates the
  "single source of truth per concern" invariant the rest of the money path
  already keeps.
- **Skip the inbound verification (trust the vendor's callback is genuine).**
  A forged/replayed callback is exactly how a gateway mints entitlement from an
  un-paid amount; the ledger's `onConflictDoNothing` idempotency stops duplicate
  *postings* but cannot stop the first *grant* from being a lie.
- **Fent/Vendor-specific idempotency (trust the vendor's own idempotency key).**
  The gateway-ref uniqueness must live in our schema (`payment_gateway_ref_uniq`)
  because our ref is the link from callback → payment → subscription; a vendor
  key cannot be the durable truth after a gateway migration.
- **Outbound validation fetch for every callback.** Only a gateway that requires
  it (`verify_url`) needs the outbound guard; doing it unconditionally adds a
  request and an SSRF surface where the manual-confirm model has none.

## Evidence

- `packages/platform/server/payments.ts` — `PLANS`, `qrisFor`, `resolveGrant`
  (the single grant rule), `CHANNELS`.
- `backend/go/migrations/0025_subscription_platform.sql` — `payment` table with
  UNIQUE `(gateway, gateway_ref)`; `subscription` table; `price_idr` bigint.
- `backend/go/migrations/0036_admin_credit_namespace.sql` — `purchase:` freed
  for the gateway.
- `packages/platform/server/add-credit.ts` — `admin_credit:` namespace and the
  durable `credit_ledger_idempotency_idx` idempotency pattern.
- `apps/web/server/lib/platform-ts.mjs` — the shared-TS bridge convention this
  module feeds into (criterion #4).
- `packages/platform/test/payments.test.mjs` — `resolveGrant`'s four-case
  contract this module delegates to.