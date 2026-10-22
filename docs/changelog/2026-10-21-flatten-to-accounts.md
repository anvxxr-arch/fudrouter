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
  resolvable owner is deleted **only** when it has no ledger rows; the ledger is
  the money record, while an invoice is a generated document, so an ownerless
  account's zero-value `open` invoice goes with it and the migration reports the
  counts. Any account holding ledger rows still aborts at `SET NOT NULL` rather
  than being deleted.
- Workspace-scoped budgets and rate limits become the account's, collapsed to one
  row per owner with the tightest value of each column. Project- and
  environment-scoped caps bounded a slice that no longer exists and are dropped.
- Workspace-scoped aliases, routing policies, alerts and webhooks are remapped
  to the workspace owner's user id. `usage_hourly` / `usage_daily` are summed
  into the account dimension and swapped in, with the dimension indexes rebuilt
  over the shorter tuple.

## What the rehearsal caught

Three defects, each invisible on a fresh empty database, each of which would
have aborted or corrupted the production run. They are the reason this migration
was rehearsed against data rather than schema alone.

1. **The value was never remapped.** The first draft renamed `workspace_id` to
   `account_id` but left the `wrk_…` values in place, so adding the FK to
   `user(id)` failed on the first real row.
2. **`ON CONFLICT DO UPDATE cannot affect row a second time`.** Re-keying budgets
   used an upsert, which Postgres refuses when one statement proposes two rows
   for the same conflict target — exactly what happens when one owner holds two
   workspaces. The collapse now happens in the `SELECT` (`GROUP BY` owner,
   `min()` per column), so the statement proposes each target once.
3. **An ownerless account with an invoice.** The delete guard required "no ledger
   **and** no invoice rows", so a probe workspace's zero-value `open` invoice
   blocked the delete and `SET NOT NULL` then aborted the whole migration. The
   guard is now the ledger alone.

A fourth, structural one: dropping `project_id` makes two project buckets
collapse to the same dimension tuple, which the rebuilt UNIQUE index rejects. The
aggregates are therefore summed into a temp table and swapped in — the first
draft's comment said "summing" while the SQL only renamed.

The final rehearsal ran against a **full copy of production data** (schema,
data and `schema_migration` rows), not a synthetic fixture: 678 ledger rows and
3022 request rows in, the same out, `sum(credit_ledger.amount_micro)` equal to
`sum(billing_account.balance_micro)` on both sides, every new FK validated, and
one ownerless account plus its invoice removed and reported.

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
- **Migration rehearsal, three fixtures**: (a) synthetic pre-0019 hierarchy —
  owned, member-only and owner-less workspaces, both alias scopes, ledger rows,
  aggregate buckets; (b) one owner with two workspaces, which is what fires the
  cap-collapse collision; (c) two projects under one workspace, which fires the
  aggregate tuple collision. Then (d) a **full production data copy** — schema,
  data and `schema_migration` — migrated end to end: 678 ledger rows and 3022
  request rows in and out, `sum(amount_micro)` = `sum(balance_micro)` =
  102,804,937,518 on both sides, every new FK validated, zero dangling owner ids,
  one ownerless account plus its zero-value invoice removed and reported.
- Go and Node suites run against a **freshly migrated** database, not the
  production copy: the Go tests seed their own catalogue and assert growth
  ratios (`virtual_fanout_test.go` needs 20 → 200 models), so a copy already
  holding 363 models fails the fixture assumption rather than the migration.
  AGENTS.md's "Go needs a throwaway DB" is exactly this rule.
- Console smoke on the migrated database: every `/api/pages/*` and
  `/api/admin/*` route answers 200, writes land (`key.create`, `budget.create`,
  `limit.create`, `routing.create`, `alert.create` all audited with no
  `workspace_id`), and the dashboard, limits, billing, aliases, routing, alerts
  and admin pages render with zero workspace/project wording.

## Deploy

`0019` is one-way. As of 2026-10-21 it was **not applied to the production
database** — pushing code does not migrate. Check before you start; an empty
result means it has not run:

```sh
docker exec postgre psql -U postgres -d fudrouter -At \
  -c "select name from schema_migration where name like '0019%'"
```

Then run it as the app role, never the superuser, or the tables end up
`postgres`-owned and the app gets "permission denied" on its first write. The
migrate and the restart must be ONE chain: the running processes execute
pre-0019 SQL against tables this migration drops, so any gap between the two
lines is a window of 500s.

```sh
# as the fudrouter role, not postgres — from a HUMAN shell, not an agent one
DATABASE_URL=postgres://fudrouter:<pw>@127.0.0.1:5432/fudrouter ops/migrate.sh \
  && pm2 restart fudrouter-router fudrouter-workers fudrouter-scheduler fudrouter-console \
  && bash ops/verify/pm2-env-hygiene.sh
```

`pm2 restart` must not be run from an agent shell: PM2 captures the creating
client's environment into `dump.pm2` and replays it on every `pm2 resurrect`. The
hygiene check runs **after** the restart, and `filter_env` must stay an array —
`true` is a no-op because PM2 tests `.length`, which is how provider keys leaked
into the router env once already.

Before running it, count the shapes the migration decides for you. A non-zero
`owner_user_id IS NULL` count means those workspaces' caps, alerts, webhooks and
routing policies are dropped rather than re-homed, and their usage buckets become
the unattributed (`account_id IS NULL`) bucket:

```sql
select count(*) from workspace where owner_user_id is null;
```

Measured on production on 2026-10-21: 79 workspaces, 78 distinct owners, one
owner-less (`probe-test-s-workspace`, carrying one zero-value `open` invoice and
no ledger rows), and no owner holding two workspaces. The collision paths are
therefore not live today — but they are data-dependent, and a migration runs
once, so they are fixed rather than assumed away.

The scratch databases from the rehearsals were dropped after the run. The recipe
that found every data-dependent defect is, in order:

1. `pg_dump --schema-only` of the live database, plus its real `schema_migration`
   rows, so the runner applies exactly `0019` and not the whole history.
2. A synthetic pre-0019 hierarchy. **Two shapes are required.** The obvious one
   gives each workspace its own owner, and the re-key's collision path never
   executes — that fixture passes while production breaks. The second gives ONE
   owner TWO workspaces with their own budgets and rate limits, which is what
   exposed `ON CONFLICT DO UPDATE cannot affect row a second time`.
3. A workspace with two projects, which is what exposes the aggregate tuple
   collision, and a workspace with no owner at all.
4. Last, `pg_dump --data-only` of the real database and run the migration against
   that copy. This is the only rehearsal that is evidence: it caught the
   owner-less account whose invoice blocked the delete guard.

Reconciliation queries are recorded here rather than in a surviving database.

## Follow-up: the second `workspace_id` writer

The code section above says `audit_log.workspace_id` stays as historical
evidence with nothing writing it, which was true. It did **not** cover
`system_event.workspace_id`, and that column still had a live writer: the Go
router's `store.InsertSystemEvent` took a fifth `accountID` argument and
inserted it there, so every budget-threshold and low-balance event carried a
`usr_…` id in a column named for a `wrk_…` one. `packages/platform/server/alerts.ts`
had already stopped, so the two planes disagreed about the same column —
exactly what the migration's own note ("only new code stops writing it")
forbids.

Fixed in `0588e91`: the parameter and both call sites (`budgetEvaluate`,
`raiseLowBalance`) are gone. Nothing reads the column — the admin list and
health-snapshot queries select `id, type, resource, resource_id, metadata,
created_at` only — and scope is not lost, because `resource` + `resourceID`
already name what each event belongs to. The drizzle `workspaceId` field stays
in `packages/platform/db/schema.ts`: it mirrors a column that still exists and
holds historical values.
