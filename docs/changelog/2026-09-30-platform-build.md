# Platform build — the walking skeleton is live

This is the first release of FudRouter: one control plane (`apps/web`) and one
data plane (`services/router`) over a single PostgreSQL, with a shared Valkey
for counters and caches.

## Added

- OpenAI-compatible API at `/v1/chat/completions` and `/v1/models`, with
  per-token metering and an append-only request ledger.
- API keys in `sk-ar-<prefix>_<secret>` form; only `sha256(secret)` is stored.
- Workspace hierarchy: workspace, project, environment, API key.
- Provider network: providers with pooled credentials and failover across up to
  three accounts.
- The public surface: model catalog, providers directory, pricing, playground,
  status page with incidents, changelog and this documentation tree.
- An end-to-end acceptance smoke (`apps/web/scripts/e2e-smoke.mjs`) covering the
  core developer path: register → create project → create key → fund credits →
  call `/v1/chat/completions` → inspect request → inspect usage and cost.

## Fixed
- The billing credits page returned 500: the running-balance window sum was a
  raw SQL field inside the subquery without a column alias, so the outer
  reference threw during load. The `?/add` action still committed the purchase
  — only the post-action re-render failed. Aliased the field; the page renders.
- The e2e smoke no longer passes vacuously: it requires a non-empty request id
  before asserting the request detail, and confirms the credit-purchase
  feedback in the response body rather than trusting the status code alone.
