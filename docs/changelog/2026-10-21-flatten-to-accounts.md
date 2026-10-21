# The account is the tenant: the workspace hierarchy is gone

The console had been carrying a four-level ownership tree — workspace → project →
environment → API key — that the product never used. Every key already carried
`user_id` from the first schema, so the tree was a second, redundant answer to
"whose key is this", and every page paid for it: the dashboard resolved the
hierarchy before it could find a key, the limit chain had four levels to MIN
across, and the team surface existed to manage memberships in a product where
one person owns one account.

Migration `0019_flatten_to_accounts` removes `workspace`, `workspace_member`,
`workspace_role`, `project` and `environment`. Keys, billing accounts, budgets,
rate limits, routing policies, alerts, webhooks and model aliases are keyed by
the user account. Budget and rate-limit scopes are `account` and `api_key` only.

## What the migration preserves, and why the order matters

The hierarchy tables were `ON DELETE CASCADE` parents of `api_key`,
`request_log`, `billing_account`, `alert`, `webhook`, `model_alias`, `budget`,
`rate_limit`, `routing_policy` and both usage aggregates. Dropping the tables
first would have deleted every key, every ledger row and every request record in
one statement, so the columns are dropped before the tables, and the money
objects are re-keyed in place rather than recreated:

- `billing_account` keeps its id — `credit_ledger` and `invoice` cascade off it —
  and only its owner column changes from workspace to user. An account with no
  resolvable owner is deleted **only** when it has no ledger and no invoice rows;
  otherwise the `SET NOT NULL` aborts loudly instead of orphaning money.
- Workspace-scoped budgets and rate limits become the account's, taking the
  tighter of two caps if an owner had several workspaces. Project- and
  environment-scoped caps bounded a slice that no longer exists and are dropped.
- Workspace-scoped aliases, routing policies, alerts and webhooks are remapped
  to the workspace owner's user id. `usage_hourly` / `usage_daily` are re-keyed
  the same way, and their dimension indexes rebuilt over the shorter tuple.

**Rehearsing found the bug this file exists to warn about.** The first draft
renamed `workspace_id` to `account_id` without remapping the *value*: the column
still held `wrk_…` ids, so adding the new FK to `user(id)` failed on the first
real row. A fresh empty database never shows this — the failure needs data. The
same rehearsal is why the budget/rate-limit re-key exists at all: the first
draft deleted workspace-scoped caps, which would have silently removed a spend
control the operator had set.

## Code

- `packages/platform/server/db/schema.ts` — the five tables and their scope
  columns are deleted; `routingPolicy.accountId`, `modelAlias.accountId`,
  `usageHourly/usageDaily.accountId`, `billingAccount.userId`,
  `alert.accountId` and `webhook.accountId` replace them. This file is loaded at
  **runtime** by the workers, the scheduler and the Express bridge, so leaving a
  stale table here is a 500 on the next scheduler tick, invisible to `tsc`.
- `packages/platform/server/{alerts,billing,webhooks,audit,id,workers}.ts` —
  measurement and webhook matching scope on the account; the usage rollup reads
  `request_log.user_id` into `usage_*.account_id` (two dimension lists, because
  the source and target column names differ); `ensureBillingAccount` takes a
  user id; the audit writer no longer writes `workspace_id`.
- `apps/web/server/` — the `/api/pages/workspace` and `/api/pages/projects/**`
  routes and the admin workspace block are gone; `audit_log.workspace_id` stays
  as historical evidence but nothing writes it, so the audit and system-event
  views stopped selecting it.
- `apps/web/server/public.mjs` — the docs described the hierarchy and linked to
  `/dashboard/projects/new`. The quickstart is now four steps (sign in, mint a
  key, call the API, read the log) and the Projects section is Accounts.

## Gates

- `npm run check` → tsc ×3, contracts (7 inference / 159 management), structure
  PASS. The management surface went 191 → 159 when the hierarchy routes left; the
  non-triviality floor moved 180 → 150 to track it, and still fails a scanner
  that matches nothing.
- `go vet ./...`, `go build ./...` → clean; `go test ./...` → **13/13 packages**
  against a freshly migrated database (proxy 85.5 s, store 10.2 s).
- `npm test` → **128 pass / 0 fail / 6 skipped** (Valkey and two
  credential-verdict tests), against the same database.
- **Migration rehearsal**: `pg_dump --schema-only` of the live database plus its
  real `schema_migration` rows, a synthetic pre-0019 fixture (owned, member-only
  and owner-less workspaces; workspace- and project-scoped aliases; ledger rows;
  aggregate buckets), then `ops/migrate.sh`. Result: every FK validated, zero
  dangling owner ids, ledger rows intact, both cap scopes present.
- Console smoke on the migrated database: every `/api/pages/*` and
  `/api/admin/*` route answers 200, writes land (`key.create`, `budget.create`,
  `limit.create`, `routing.create`, `alert.create` all audited with no
  `workspace_id`), and the dashboard, limits, billing, aliases, routing, alerts
  and admin pages render with zero workspace/project wording.

## Deploy

`0019` is one-way. As of 2026-10-21 it was **not applied to the production
database** — pushing code does not migrate. Run it as the app role, never the
superuser, or the tables end up `postgres`-owned and the app gets "permission
denied" on its first write:

```sh
# as the fudrouter role, not postgres
DATABASE_URL=postgres://fudrouter:<pw>@127.0.0.1:5432/fudrouter ops/migrate.sh
pm2 restart fudrouter-router fudrouter-workers fudrouter-scheduler fudrouter-console
bash ops/verify/pm2-env-hygiene.sh
```

`pm2 restart` must not be run from an agent shell: PM2 captures the creating
client's environment into `dump.pm2` and replays it on every `pm2 resurrect`. The
hygiene check runs **after** the restart, and `filter_env` must stay an array —
`true` is a no-op because PM2 tests `.length`, which is how provider keys leaked
into the router env once already.

The scratch databases (`flat_go`, `flat_go2`, `flat_prodshape`, `flat_final`)
were dropped after the run; the rehearsal is reproducible from the recipe above
— `pg_dump --schema-only` of the live database plus its `schema_migration` rows
plus the fixture shapes listed here — and the reconciliation queries are
recorded in this file rather than in a surviving database.
