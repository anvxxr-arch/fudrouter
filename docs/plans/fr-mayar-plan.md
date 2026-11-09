# PLAN — Mayar Payment Gateway Integration (fudrouter)
Status: DRAFT for brutal judge BEFORE any code. Vendor chosen by owner (docs.mayar.id).

## Facts (docs.mayar.id, fetched 2026-11-09)
- API **V1 deprecated 1 Oct 2026** -> must use **V2**. Base `https://api.mayar.id/hl/v2`
  (prod) / `https://api.mayar.io/hl/v2` (sandbox). Auth `Authorization: Bearer <API_KEY>`.
- Create payment request: `POST /hl/v2/payments/create`
  {name,amount(int IDR),email?,mobile?,description?,notes?,redirectUrl?,expiredAt?,paymentMethod?,extraData?}
  -> {data:{id,transactionId,link,redirectUrl?}}.
- Dynamic QRIS: `POST /hl/v2/qr-codes/create {amount}` -> {data:{url,amount,qrString}}.
- Transaction: `GET /hl/v2/transactions/{uuid}` -> data.status in {paid,unpaid,created,expired}, data.amount.
- Webhook: `POST /hl/v2/webhooks/update {urlHook}`; events incl. `payment.received`.
- **No documented HMAC/signature on the webhook.**

## Goal
Turn the dormant `qris-native` gateway (ADR-0008) into a real Mayar-backed gateway:
create payment -> QRIS/link -> receive settlement -> grant subscription, without weakening
any existing money invariant (idempotent create, single grant rule `resolveGrant`, ceiling, audit).

## Non-goals
No pricing change; no member self-service credit mint (W4 removed it); not flipping
FUDROUTER_BILLING_ENFORCE; no invoice/installment/coupon features.

## Design
### 3.1 `packages/platform/server/mayar.ts` (vendor adapter, injected fetch)
MayarClient over injected fetch (tests need no network). `MAYAR_API_BASE`/`MAYAR_API_KEY` from env
(key never logged). Errors mapped to a small taxonomy. Outbound via `guardedUpstreamFetch`.

### 3.2 Create
Persist the payment row FIRST (status pending), then call Mayar `payments/create`, carrying our
`gatewayRef` (persist Mayar `data.id` + `transactionId` on the row too — do NOT rely on extraData
echo; see judge B1). Retry with same idempotency key reuses the row (idempotent on gateway_ref).
Return the Mayar `link` (checkout URL). Fallback: `MAYAR_API_KEY` unset -> current static QR path.

### 3.3 Settlement (security-critical)
No webhook signature => the webhook body is a HINT only. On `payment.received`: match our payment
row, then **server-side `GET /hl/v2/transactions/{transactionId}`** and require status==='paid'
AND amount===plan.priceIdr AND fetched id === the transactionId persisted on the row. Only that
authenticated read authorizes the grant, via existing `confirmAndGrant`/`resolveGrant`.

### 3.4 Idempotency/replay
`confirmAndGrant` idempotent on payment_id (one grant). Replayed webhook -> already confirmed ->
no second subscription. Per-IP rate limit on the webhook.

### 3.5 Config (operator, fail-closed)
`MAYAR_API_KEY`, `MAYAR_API_BASE`, `MAYAR_WEBHOOK_ENABLED` (default off).

### 3.6 Tests (TDD, no network)
mayar client request/error mapping/key-never-logged; create with/without key; webhook forged
(unpaid->no grant), paid+mismatch->no grant, paid+match->exactly one grant, replay->still one.

## Rollout
Land additive code+tests -> operator creates Mayar account/key/registers webhook/sets env ->
sandbox first (simulate paid) -> prod. Done only after a sandbox settlement grants a sub end-to-end.

## Risks
R1 no webhook signature -> mandatory server-side re-fetch (rate-limited). R2 integer IDR. R3 V2
write endpoints may return `message` vs `messages`. R4 redirectUrl conditionally supported.
R5 payments/create vs qr-codes/create artefact choice. R6 sandbox/prod key pairing.
