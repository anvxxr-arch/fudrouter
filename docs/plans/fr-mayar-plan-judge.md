# BRUTAL JUDGE — Mayar gateway plan
Verdict: REVISE (do not implement as written). 3 BLOCKERS, 4 HIGH, 3 MED.
(Dispatched judges died on a transient upstream 400; gate honored by direct adversarial review.)

## BLOCKERS
B1 extraData echo UNVERIFIED and the plan's matching hinges on it. Must persist Mayar
   `data.id`+`transactionId` onto the payment row and match on that; prove echo on sandbox first.
B2 Webhook body vocabulary contradictory (bool `status` vs string "SUCCESS") -> webhook is a hint
   ONLY; money decision solely from `GET /hl/v2/transactions/{id}`.
B3 Changing GATEWAY_DEFAULT breaks existing-row lookups (gateway-store.ts:60 matches
   gateway=GATEWAY_DEFAULT) and the UNIQUE (gateway,gateway_ref) index could allow duplicates.
   Keep GATEWAY_DEFAULT; add `mayar` as an additive value; match ref alone or gateway IN (...).

## HIGH
H1 re-fetch must bind to OUR row (fetched transaction id + amount == the row's persisted facts),
   not trust an attacker-supplied transactionId.
H2 assert integer IDR + amount equality.
H3 payments/create (checkout URL) vs qr-codes/create (raw QRIS) — decide the member artefact and
   update the FE contract in the same plan.
H4 no reconciliation sweep for missed webhooks -> add `mayar_reconcile` scheduler job (idempotent).

## MED
M1 key/base URL must be paired (prod base never with sandbox key) + rotation doc.
M2 observability counters + rollback (unset key -> static QR), tested.
M3 scope for "payment gateway fast": expiry, member failure UX, amount-mismatch surfacing.

## Verify on sandbox before coding
1 extraData/redirectUrl echo  2 exact paid webhook payload  3 transactions/{id} id vs transactionId
4 payments/create returns usable link  5 sandbox simulate to force paid.
