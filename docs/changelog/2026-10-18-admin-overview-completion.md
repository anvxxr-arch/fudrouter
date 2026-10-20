# The admin overview now renders every number the schema can support, and refuses the ones it cannot

`AdminHome` (`apps/web/src/routes/admin.tsx:74`) was a page of bare counts: providers,
models, connections, keys, users, requests, tokens, cost — seven `Card`s fed by one
`Promise.all` of `count(*)` queries, plus two tables. An operator landing on `/admin`
learned how big the platform is and nothing about what it is doing. The member
dashboard had already grown stat cards with deltas and sparklines
(`routes/dashboard.tsx:152-154`); the admin overview had no equivalent, because the
payload it was given carried no history and no revenue. This entry records the
completion of that page — and, more importantly, the boundary it deliberately stops
at.

## The three additive keys

`GET /api/admin/overview` (`apps/web/server/admin.mjs:401`) gained three keys, all
additive, so no existing consumer breaks:

- `series` — 14 days of `usage_daily` (`admin.mjs:418`), zero-filled server-side.
- `revenueMtdMicro` — month-to-date `credit_ledger` sum over `credit_purchase` and
  `promotion` (`admin.mjs:425`).
- `counts.workspaces` — one more `count(*)` in the existing `Promise.all`
  (`admin.mjs:408`, `admin.mjs:446`).

`GET /api/admin/billing` (`admin.mjs:519`) gained `monthly`: 12 months of
`credit_ledger` totals broken down by ledger type, zero-filled server-side
(`admin.mjs:543-557`). `GET /api/admin/users` (`admin.mjs:900`) gained
`firstRequestAt` and `workspaceName` (`admin.mjs:952-953`).

`firstRequestAt` is a `min(created_at)` riding the existing `groupBy`
(`admin.mjs:915`) — the same scan that already produced `lastRequest`, so the
signups column costs nothing. `workspaceName` is one name per user, the first by
workspace creation order (`admin.mjs:921-922`); the Users page itself still shows
only counts, because a user with three workspaces has no single "their" workspace
and picking one there would be a lie.

## Zero-fill is server-side because the client cannot tell a short series from an empty one

Both series are materialised to full length in the handler, not in React. A fresh
database has no `usage_daily` rows and no ledger rows, so the raw query returns
`[]`; the client would then render a zero-width sparkline and a chart with no axis,
which looks identical to "no traffic this month" and is indistinguishable from a
broken fetch. `Array.from({length: 14}, …)` (`admin.mjs:420-424`) and
`Array.from({length: 12}, …)` (`admin.mjs:553-557`) make the shape a contract: the
last two entries are always today and yesterday, so `series[series.length - 1]` and
`series[series.length - 2]` (`admin.tsx:83-84`) are always the delta pair. The
zero-fill assertions in the new test are the load-bearing ones for exactly this
reason.

`usage_daily` is the only table with real history — `request_log` is pruned by
retention, so a 14-day window over it silently shortens as rows age out. That is
also why the revenue chart reads `credit_ledger` and not `request_log`.

## StatCard moved out of the dashboard chunk

`StatCard` and `pctDelta` now live in `apps/web/src/components/stat-card.tsx`
(`stat-card.tsx:9`, `stat-card.tsx:16`), moved verbatim out of
`routes/dashboard.tsx`. `App.tsx` lazy-splits the two trees separately
(`App.tsx:18-19` for admin, `App.tsx:24` for the dashboard), so importing the
component from `dashboard.tsx` would have pulled the whole member-dashboard chunk
into the admin chunk for two small functions. Both pages now import from the shared
home; `dashboard.tsx` behaviour is identical. The `.stat-*` classes stay in
`routes/dashboard.css`, which both pages already import (`stat-card.tsx:4-7`).

The revenue chart is pure SVG (`admin.tsx:110-145`) — the console ships no charting
dependency and a stacked bar over 12 fixed buckets is the whole need.

## What is deliberately absent

This is the point of the entry. The page renders deltas and sparklines for
**requests, tokens and cost only** (`admin.tsx:87-89`), because `usage_daily` is
the only table with a history to diff. The entity counts — providers, models,
connections, activeKeys, users, workspaces — ship as plain cards with no delta
(`admin.tsx:91`): there are no snapshots of those tables, so a delta would have to
be fabricated, and a fabricated delta is worse than an absent one. An operator who
sees "+12% providers" with no basis for it will act on it.

The revenue chart is **by ledger type, not per tier**. No plan or subscription
table exists in the schema (`packages/platform/server/db/schema.ts` has none), so
per-tier revenue is not computable from anything the platform stores. The heading
and the chart's `aria-label` both say ledger type (`admin.tsx:94`,
`admin.tsx:122`) so the dimension is never misread. Revenue MTD carries no delta
for the same reason — there is no intramonth baseline to diff against, and
month-start is not a comparable period.

The Recent signups table has no tier column (`admin.tsx:98-100`), for the same
reason: the column would be empty or invented for every row.

Infrastructure-health dots for the data plane :8100, the control plane :3000, the
workers, the scheduler and Caddy were deliberately **not** added. The Express
process cannot see those processes — it shares a Postgres and a Valkey with them
and nothing else — so any dot would be a fabrication dressed as an observation.
Only Postgres and Valkey are real, and only those appear on the System page
(`admin.mjs:890`).

## The gate

`apps/web/tests/integration/admin-overview.test.mjs` (new) pins the three shapes:
the 14-day series, the 12-month monthly series, and the users
`firstRequestAt`/`workspaceName` keys. Each is a shape the client trusts and a
missing or short series renders as a silently wrong chart rather than an error,
which is the failure mode with no natural detector. The zero-fill assertions
(`admin-overview.test.mjs:60`, `:81`, `:84`) are the ones that would catch a
regression to returning the raw query result.

## Verified

- `NODE_ENV=development npm run check` → exit 0 (tsc ×3, contracts: 7 inference +
  189 management routes match, structure: PASS).
- `npm test --workspace apps/web` → **127 tests, 122 pass, 0 fail, 5 skipped**
  (the `VALKEY_URL`-gated ones).
- `npm test -w @fudrouter/contracts` → `surface.test.mjs` **8/8**.
- Vite build → exit 0, admin chunk **~48 kB**, dashboard chunk unchanged —
  confirming the `stat-card.tsx` split held and the admin tree did not absorb the
  member dashboard.
