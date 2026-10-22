# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two confirmed audiences, one product.

**API buyers** — developers and small teams who need model access without holding
an account at every upstream provider. They sign in once, mint one key, and point
existing OpenAI-compatible clients at the router. Their job: ship a feature that
calls a model, without vendor-by-vendor signup, billing and key rotation.

**The operator** — one person runs the platform: onboards providers, attaches
connections and credentials, watches health and spend, and settles billing from
the `/admin` surface. Not a customer-facing role; there is no support team behind
it, which is why every admin action is auditable and every guard is server-side.

## Product Purpose

A commercial AI router. It sells metered access to many upstream model providers
behind one API key, and keeps an auditable record of every request: what was
asked, which upstream served it, what it cost, and which ledger entry charged for
it. Success is a customer's traffic flowing continuously while the operator can
answer, for any single request, where the money went.

## Positioning

The router is the authority, not the console. The Go data plane re-authenticates
every key, re-resolves limits and carries its own SSRF guard, so a compromised or
misconfigured control plane cannot mint traffic the router will accept. A
neighbouring product can copy the "one key, many providers" pitch; it cannot
truthfully copy "the billing plane and the enforcement plane do not trust each
other, and both are testable independently."

## Operating Context

- Sign-in is Discord-only. There is no password path in any environment a person
  uses; the email/password endpoint exists solely so the integration harness can
  create fixtures under `NODE_ENV=test`.
- **Signing in also joins the user to the FUDCourt Discord server**
  (`lib/discord.mjs`, guild `1358116767217614898`). It fires after the session is
  created, is never awaited, and can never fail a login — a Discord outage must
  not lock anyone out of their own account. This is part of onboarding, not a
  separate step the user performs.
- The account is the tenant. A key, a billing account, a budget and a routing
  policy each belong to one user account directly. There is no workspace,
  project or environment layer — see *Capabilities and Constraints*.
- The public site (marketing, pricing, docs, status) and the console live on one
  origin; `/dashboard` and `/admin` are the two authenticated surfaces.
- The playground is the only path that crosses planes: the console mints a
  short-lived key, streams from the router, and always reclaims it.
- Operations run under PM2 on one host, with Postgres and Valkey as the only
  stateful services.

## Capabilities and Constraints

- **Per-account model (durable).** Migration `0019_flatten_to_accounts` removes
  `workspace`, `workspace_member`, `workspace_role`, `project` and `environment`.
  Keys, billing accounts, budgets, rate limits, routing policies, alerts, webhooks
  and model aliases are keyed by user account. Budget and rate-limit scopes are
  `account` and `api_key` only.
- **Metering is the product.** Every request writes `request_log` plus one
  `credit_ledger` row of type `usage_charge`, keyed `usage:<request id>` so a
  retry can never double-charge. `balance_micro` is a cache; the ledger is truth.
- **Limits resolve to the minimum** across platform hard limits, the account and
  the key's own policy. A specific level may tighten, never exceed.
- **Keys are hash-only.** `sk-ar-<prefix>_<secret>`; only `sha256(secret)` is
  stored. The TypeScript and Go sides must stay byte-compatible.
- **Money never touches a float.** Token counts are `int64`, prices are
  `numeric(18,6)`, cost is computed through `math/big`.
- **The public API surface is frozen.** `packages/contracts` holds `routes.json`
  and the OpenAPI documents behind an 8-test gate; a new inference route fails
  the build until it is declared.
- **Streaming must not be buffered.** Any buffering breaks time-to-first-token
  and the `ttft_ms` column.
- **Deliberate non-goals:** no Rust backend until a measured bottleneck exists;
  no Go management API (the Express `/api/admin/*` surface stays); no e2e or load
  harness.
- **Self-serve checkout is planned.** Customers will buy credits themselves
  rather than relying on the operator to post ledger rows from `/admin`. Until it
  ships, billing stays operator-settled: the customer-facing billing page reports
  balance and spend and takes no card details. What it does take is a *payment
  intent* — a chosen method plus a contact, stored as a `system_setting` row so
  the operator can follow up offline. That row is a preference, not a stored
  payment method, and the checkout build replaces it.
- **The payment gateway is undecided** — to be chosen when the checkout surface
  is built, not before. Nothing in the billing code commits to a provider.
- **The product is English-only.** Console copy, docs and marketing are English;
  Indonesian is not a product locale. No i18n layer, no switcher, no translated
  strings until someone decides otherwise.
- **Undecided:** multi-region deployment, and any team or sharing feature.

## Accessibility & Inclusion

Target: **WCAG 3** (<https://www.w3.org/TR/wcag-3.0/>). WCAG 3 is a W3C Working
Draft, not yet a Recommendation and with no conformance regime, so it directs the
work rather than certifying it. Until it stabilises, the enforceable floor is
WCAG 2.2 AA: contrast, visible focus, keyboard operability and target size on
every console surface. State the tradeoff rather than silently substituting a
different standard.

## Brand Commitments

- The product name is FUDRouter; the product origin is `fudrouter.my.id`,
  with `https://www.fudrouter.my.id` trusted as an auth origin too
  (`index.mjs` `trustedOrigins`). The legacy `ai.karepmuwes.my.id` host was
  retired on 2026-10-21 and must not be reintroduced — a second trusted origin
  keeps accepting auth for a name that no longer resolves here.
- Sign-in is Discord. That is an identity commitment, not an implementation
  detail — it shapes who can become a customer and how onboarding reads.
- Voice in the product is direct and specific: name the constraint, drop the
  marketing filler.

## Evidence on Hand

No testimonials, customer logos, case studies, benchmarks or press exist. Future
work must not fabricate any. The only real evidence available is live platform
data: the public model catalogue, the status page's incident history, and
request/usage records.

## Product Principles

1. **Enforce where the traffic is.** Guards live in the plane that serves the
   request; the console's checks are convenience, never the boundary.
2. **The ledger outranks the cache.** Balances, counters and aggregates are
   caches of records that can be recomputed; no design may make a cache
   authoritative.
3. **One definition, no copies.** A rule (SSRF blocklist, reachability, role
   table, nav registry) exists once and is imported, because duplicated rules
   drift and the drift is invisible until it costs money.
4. **Say what is true.** Errors name the real cause to the operator and stay
   opaque to the caller; the public catalogue and status page report what the
   platform actually served, never a placeholder.
5. **Delete the layer that earns nothing.** The workspace hierarchy was removed
   for this reason; the same test applies to every abstraction added next.
