# Target — Subscription Platform (owner directive 2026-10-31)

**Status:** ACTIVE. This supersedes the pay-per-token-only product record for the
member-facing surface. The Go data plane's metering/ledger stays; what changes is
how a member *pays* and how their key is *guarded*.

## Why this document exists

The owner set the target before code (directive: "always set the target before
code"). Every change below is measured against it. Nothing is built that this
document does not name.

## Acceptance criteria (verbatim, then operationalized)

1. **Clean architecture.** One concern per package/module; the existing DI idiom
   (Go: `proxy.New(store, crypt, client, refresher, vk)`; Node: `register*(app, ctx)`)
   is kept. No new top-level dirs without an ADR (structure gate).
2. **Tidy, documented code.** Comments are justificatory (name the bug/alternative),
   matching `rate-limit.mjs:1-12`, `netguard.go:1-22`.
3. **Tested ≥4 times with different logic** — every new unit carries four cases:
   `success`, `error`, `warn`, `unknown`. "Unknown" = the input the code has never
   seen (missing field, unmodelled enum, absent row).
4. **Capacity: 3000+ users × 5 concurrency × 150 TPS.**
   - 3000 users × 5 concurrent = 15,000 in-flight requests.
   - 150 TPS per concurrency slot is the *upstream* rate; the router's own
     admission must not be the bottleneck.
   - This is a **load target**, so it is proven by a benchmark/load harness, not
     asserted. The Go admission path (auth → limits → budget → route) must hold
     p99 well under the upstream budget at 15k concurrent.
5. **Never swallow the result.** Every phase ends with a skeptical re-read: what
   is still slow, still duplicated, still unproven. Recorded in the phase log.
6. **Max payload 32 MB** (owner rule 18). Every inbound body — inference and
   management — is capped at 32 MiB. The Go data plane already bounds the
   upstream body; the cap must be explicit and tested, not incidental.
7. **Cache hit rate ≥ 60%** (owner rule 19). The catalogue, model render, policy
   and entitlement caches must together serve at least 60% of reads from cache
   under the load model. This is measured, not asserted — a cache that misses
   more than it hits is a cost, not a saving.
8. **Manual QRIS verification** (owner rule 20). Payments are QRIS dynamic
   (`verssache/qris-dinamis`), settled by an operator who is notified on Discord
   and Telegram. No automated gateway is wired; the admin is the settlement
   authority.
9. **Admin approval flow** (owner rule 21). On a claimed payment the bot asks
   the admin (`@zupaxx` on Telegram) with inline buttons: "did the user really
   make this transaction? this is the image reference". **Yes** → publish the
   member's API key. **No** → follow up with the member to pay.

## Feature list (the deliverable)

| # | Feature | State today | Work |
|---|---|---|---|
| 1 | Billing | exists | keep; add subscription entitlement |
| 2 | Payments | intent-only | real gateway adapter + webhook |
| 3 | Discord bot payments | none | bot command → payment intent → grant |
| 4 | Telegram bot payments | none | bot command → payment intent → grant |
| 5 | Member dashboard | exists | add subscription + IP + warnings panels |
| 6 | Admin dashboard | exists | add payments/subscriptions/warnings views |
| 7 | Public pages | exists | keep |
| 8 | Models pages | exists | keep |
| 9 | Providers pages | exists (admin) | keep |
| 10 | Stats pages | partial | add member + admin stats |
| 11 | Login (Telegram + Discord) | Discord only | add Telegram OAuth |
| 12 | Pricing (subscriptions only) | none | 1d=5k, 3d=12k, 7d=30k, 14d=50k, 28d=90k IDR |
| 13 | 1 API key per member | multi-key | enforce single active key |
| 14 | Max 3 IPs per key | none | IP allowlist, 3 slots |
| 15 | Auto-restrict API key | none | restrict on abuse/expiry |
| 16 | Auto-warn (API/Telegram/Discord) | none | warning pipeline, 3 channels |
| 17 | Discord + Telegram marketplace | none | listing surface + bot commands |

## Pricing (IDR, subscriptions only)

| Plan | Days | Price (IDR) |
|---|---|---|
| `sub_1d` | 1 | 5,000 |
| `sub_3d` | 3 | 12,000 |
| `sub_7d` | 7 | 30,000 |
| `sub_14d` | 14 | 50,000 |
| `sub_28d` | 28 | 90,000 |

No per-token checkout. Token metering still runs (it feeds abuse detection and
the ledger), but a member buys *time*, not tokens.

## Payment flow (owner rules 20, 21)

```
member picks a plan (web / discord / telegram)
        │
        ▼
router mints a QRIS dynamic payload for the exact amount
  (verssache/qris-dinamis; merchant payload pinned below)
        │
        ▼
member pays, uploads a screenshot / sends the reference
        │
        ▼
bot notifies the admin (@zupaxx on Telegram + a Discord channel)
  with inline buttons:  [ Yes, real ]   [ No, follow up ]
        │
   ┌────┴─────┐
   ▼          ▼
  Yes        No
   │          │
   ▼          ▼
grant       bot messages the member to complete payment
subscription
+ publish
the API key
```

The merchant QRIS payload (owner-supplied, pinned so it is not retyped):

```
00020101021126610014COM.GO-JEK.WWW01189360091439738305930210G9738305930303UMI51440014ID.CO.QRIS.WWW0215ID10243394679450303UMI5204733353033605802ID5919LEV. SPACE, Jakarta6005TUBAN61056238262070703A0163049B3A
```

The amount is injected into the payload's tag 54 (transaction amount) per the
QRIS dynamic spec; the static payload above carries no amount.

## Capacity model (the number that decides the design)

```
3000 users
  × 5 concurrent requests each      = 15,000 in-flight
  × 150 TPS per slot (upstream cap) = 2,250,000 TPS theoretical upstream
```

The router cannot and must not try to serve 2.25M TPS. What it must do:

- **Admission is O(1) per request** and does not allocate per-candidate beyond
  the candidate slice it already needs.
- **Per-key concurrency (5) and per-key IP (3) are enforced in-process** with a
  counter, not a DB round-trip, so 15k concurrent admissions do not serialize on
  Postgres.
- **Rate limiting stays in Valkey** (`rl:`/`conc:`) with the in-process fallback
  already present; the fallback must be correct under 15k concurrent (it is the
  path that runs when Valkey blips).
- **The DB is never on the hot path** for admission. It is read once per key
  (cached 60s, already the case) and written once per request at `finish()`.

## Non-goals (YAGNI, named so they are not built)

- No per-token checkout (owner: subscriptions only).
- No multi-key per member (owner: exactly one).
- No new top-level directory (structure gate + ADR-0006).
- No Rust (ADR-0003).
- No payment gateway chosen until the payments phase — the adapter interface is
  built first, the concrete gateway second.

## Phase order (backend/logic first, per directive)

1. **Schema** — subscription, payment, key-IP, warning tables (one migration).
2. **Entitlement + key guard** — Go: single-key, 3-IP, concurrency, auto-restrict.
3. **Payments core** — adapter interface + webhook + grant.
4. **Bots** — Discord + Telegram payment/warn/marketplace commands.
5. **Surfaces** — member/admin/stats/pricing pages.
6. **Load proof** — 15k-concurrent admission benchmark; record p99.

Each phase: implement → 4-case test → benchmark where it touches the hot path →
skeptical re-read.
