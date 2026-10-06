# S0-C — Role-based page surfaces (public / member / admin)

**Date:** 2026-09-22
**Status:** P1 implemented & verified (2026-09-22) · P1.5 design system shipped (2026-09-22) · UI hardening + a11y pass (2026-09-22: axe 0 violations / 21 pages, plus 4 probe-only WCAG classes at 0 findings) · API-surface model catalog shipped with placeholder tiers (2026-09-22) · UI font switched to self-hosted Plus Jakarta Sans (2026-09-22) · type scale replaced with a 12-step static/fluid ladder (2026-09-22)
**Design spec:** `DESIGN.md` (repo root) — normative; linted with `@google/design.md`
**Sub-project:** S0-C (surface architecture; spans the UI slices S4 client dashboard and S5 admin panel)
**Depends on:** S0 (foundation, walking skeleton) — shipped
**Spec:** `docs/specs/2026-09-21-s0-foundation-design.md` §2 (decomposition), §8 (auth & RBAC)

---

## 0. Design system (P1.5 — shipped)

The surfaces are built on one design system, not per-page CSS.

| Artifact | Path | Role |
|---|---|---|
| `DESIGN.md` | repo root | normative spec — colors, type scale, spacing, radii, components, surface rules |
| `lib/design/tokens.css` | `apps/web/src/` | the spec as `--fr-*` custom properties + base layer + `table.fr` / `.num` / `.muted` primitives |
| `lib/design/theme.tailwind.css` | `apps/web/src/` | Tailwind v4 `@theme` export of the same palette (generated) |
| `lib/ui/*.svelte` | `apps/web/src/` | atomic layer — `Button`, `ButtonLink`, `Input`, `Select`, `Textarea`, `Field`, `Badge`, `Card`, `StatCard`, `Alert`, `PageHeader`, `EmptyState` |

**Enforcement.** `lib/design/tokens.test.ts` fails the suite if `DESIGN.md` and
`tokens.css` drift apart in either direction. The spec itself is linted with
`npx -y @google/design.md lint DESIGN.md` (0 errors; 1 warning for `colors.bg`,
which is the page canvas and structurally consumed rather than component-bound).

**Design psychology applied.** One primary action per screen (Von Restorff);
40px control height (Fitts's law); status as colour **plus** word (colour-blind
safety); tabular figures so columns never jitter; uppercase labels over lowercase
values; empty states that name the next action; `vertical-align: middle` so
badges and buttons share a row baseline.

**Verified defects fixed during review:** `Select` defaulted `value=''`, which
cleared the native selection so `/admin/users` rendered blank role pickers
(`selectedIndex: -1`); table cells were top-aligned, leaving badges 7px high; the
action column had no header.

### 0.1 Hardening pass (UI-only session)

- **Responsive.** Every surface overflowed horizontally at 390px — `/admin/requests`
  dragged the document to 1149px (`+759`). Root cause: a grid item's default
  `min-width: auto` refuses to shrink, plus wide tables. Fixed with `min-width: 0`
  on the content column and a `.table-wrap` scroll container around all 15 tables.
  Now `doc == viewport` at 390 and 1280, and every numeric cell is a single line.
  Nav collapses to one scrollable row below 820px (wrapping stranded the last tab).
- **Error boundary.** There was no `+error.svelte`, so SvelteKit's bare fallback
  served 404s. One root boundary now covers 404 and 500 — verified both branches
  (a temporary `error(500)` route, removed after).
- **Titles + meta.** No page had a `<title>`. `$lib/titles.ts` + the root layout
  set one from the pathname (longest-prefix, same rule as `ROUTE_CAPS`); the error
  page is titled by status. `theme-color` and `description` added to `app.html`.
- **Verified reachable, not clipped:** scrolling `/admin/requests` to
  `scrollLeft = 927` (its max) swaps the visible headers from `When` to
  `Latency, Status` — the off-screen columns are reachable, not cut off.

**Backend defect found and fixed in the same session:** ~12% of minted API keys
were unparseable — the base64url prefix alphabet includes `_`, which is also the
prefix/secret separator, so `Parse` split in the wrong place. Fixed by redrawing
the prefix until it is `_`-free (`randomPrefix()` in `keys.ts`). Verified three
ways: an invariant test over 5000 keys (fails 633/5000 against the old line),
20000 TS-minted keys parsed by the real Go `Parse` (0 mismatches), and 60 keys
minted through the live admin action then authenticated against the running data
plane (0 rejected). See the `fudrouter` skill, "Key format invariant".

### 0.2 Accessibility & interaction feedback (axe-verified)

Audited with real `axe-core` against 21 live pages (10 public + 11 authed) under
`wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa` / `best-practice`. Result: **0
violations, 0 redirect mismatches** (the run asserts the landed URL, because a
`user`-role session 303s every `/admin/*` page through `/` to `/dashboard` — the
first pass silently audited the dashboard eleven times and reported its violations
as admin ones).

Two real defects, both invisible to inspection:

- `link-in-text-block` (serious) — a link inside running text was signalled by
  colour alone (WCAG 1.4.1). Inline links in `p`/`li`/`dd`/`dt`/`td` are now
  underlined; nav, buttons and badges stay clean.
- `select-name` (critical) — the 13 per-row role pickers on `/admin/users` had no
  accessible name. Each now carries `aria-label="Role for {u.email}"`, as do the
  repeated in-table buttons (`Revoke`, `Delete`, `Save`, `Test`), which read fine
  visually but announce identically in a screen reader.

Gaps closed that axe does not flag (WCAG 2.4.1 / 2.3.3 and plain UX):

- **Skip link** on every surface — first tab stop, off-screen until focused,
  targeting `#content`, the wrapper *after* the nav (a root `#main` would land
  where the link already is, since surface headers render inside it).
- **`prefers-reduced-motion`** — one base-layer block collapses every transition
  and animation in the document. Verified document-wide, with a `no-preference`
  control run so the test cannot pass vacuously.
- **Announced waits** — a 2px top progress bar plus an `sr-only` `role="status"`
  ("Loading page") during route loads; `aria-busy` + disabled + a trailing `…` on
  submit buttons during form actions. 13 forms wired via `$lib/forms.ts`
  (`withPending`).

Verified with Playwright (11/11 checks): skip link rests at `top: -64px`, becomes
the first tab stop, and lands `#content` at `top: 117px` after Enter;
reduced-motion leaves **0** of 70 elements animating while the control leaves 1
(`0.12s`); the progress bar is observed at `2px` with `role=status` reading
"Loading page"; a held POST shows `aria-busy="true"` / `disabled` / `"Log in…"`
and clears to `null` / `false` / `"Log in"` after the response. Document width
stays `390/390` at 390px — the `position: absolute` skip link adds no overflow.

### 0.3 WCAG classes axe cannot test (focus / reflow / targets / spacing)

axe covers roughly half of it. Four further classes were probed directly in the
browser (computed-style diffing, 320px reflow, target measurement, a 1.4.12
text-spacing override) across the same 19 pages. Three real defects, all invisible
to both axe and inspection:

- **Focus was invisible on the active nav link** (WCAG 2.4.7). `aside a.active`
  and `.admin-nav a.active` draw their active bar with `box-shadow`, and those
  selectors (0,1,2) outrank a bare `:focus-visible` (0,1,0) whichever file loads
  last — so the ring lost on exactly the element a keyboard user tabs to first.
  Exactly one element per authed page. Fixed by drawing focus with `outline`
  instead (`--fr-focus: 2px solid var(--fr-primary)` + `outline-offset: 2px`);
  nothing else sets `outline`, so it cannot be clobbered. The active bar survives
  (`box-shadow: inset 2px 0 0` confirmed still applied alongside the ring).
- **Two pages failed 320px reflow** (WCAG 1.4.10): `/docs` overflowed **+168px**,
  `/account` **+53px**. Both are the grid `min-width: auto` trap — `.stack`
  (a single-column grid) let a `<pre>` of long curl lines stretch its column to
  max-content instead of scrolling in its own `overflow-x: auto` box, and
  `dl { grid-template-columns: 8rem 1fr }` could not shrink below a long
  unbreakable email. Fixed with `.stack > * { min-width: 0 }` and
  `minmax(0, 1fr)` + `overflow-wrap: anywhere`. Note the 820px breakpoint is not
  enough for this criterion — it demands 320.
- **Header targets were 23px tall** (WCAG 2.5.8, minimum 24x24): the brand and the
  "Log in" link on every surface. Fixed with `min-height: 24px` on header/nav
  anchors. Inline links in body copy are exempt and keep their natural box.

After the fixes the same probe reports **0 findings across all four classes**
(0 elements without a focus indicator, 0px overflow at 320px on 19 pages, 0
sub-24px targets, 0 clipped elements under the spacing override), and axe still
reports **0 violations**.

### 0.4 Model catalog: API surfaces & tiers (dummy data)

The public catalog now shows *which surface serves a model, at which tier* — the
two axes the API actually splits on:

- **`/v1`** — pay as you go, billed per token.
- **`/coding/v1`** — coding plan, included in a subscription.

Neither axis existed in the data model: `model` has no `tier` and no `surface`
column, and the data plane still serves only `GET /v1/models` +
`POST /v1/chat/completions` (the `/coding/v1` prefix is S3 work — "Programs —
free credit, coding plan", per the spec, which depends on S2). So this ships the
**surface with placeholder tiers**, not the schema.

- `$lib/catalog.ts` is the single source: surface metadata (label, path, lede),
  the tier assignment, `buildCatalog()` (attaches the assignment to plain DB rows)
  and `modelsOn()` (the rows for one surface, slug-ordered). Generic in the row
  type, so `/pricing` keeps its price columns.
- Both pages render from it: `/models` shows one section per surface (heading +
  mono endpoint + lede + table with a `Tier` badge), and `/pricing` lists the PAYG
  surface only — a model not served on `/v1` has no per-token price to quote.
- The placeholder assignment lives in one clearly-marked block (`DUMMY_TIERS` /
  `DEFAULT_TIERS`) with the swap procedure in the file header: add the columns,
  move the assignment into the DB, delete the maps. `buildCatalog` already takes
  plain rows, so no caller or page changes.
- Both public pages carry a visible "Preview build — the free/premium tiers below
  are placeholder data." line, so the dummy data cannot ship unnoticed.

**Naming.** The catalog type is `ApiSurface`, not `Surface` — this repo already
uses "surface" for the *UI* audiences (public/member/admin, §4), and a shared name
would invite importing the wrong one.

**Verified.** `svelte-check` 0/0; `vitest` **52/52** (11 new catalog tests: surface
metadata completeness, distinct prefixes, tier assignment, default fallback,
per-surface tier, no duplication across surfaces, empty surface, tone mapping);
build clean; `/models` renders 2 sections with distinct endpoints and 4 badges in 2
distinct colours (free `rgb(16,185,129)` / premium `rgb(56,189,248)`); axe clean on
both pages; 0px overflow at 320px; and the full 21-page axe + 4-class WCAG probe
still reports 0 violations / 0 findings (no regression).

### 0.5 UI font: self-hosted Plus Jakarta Sans

The UI face changed from a stack that named **Inter** — which was never actually
loaded (no `@font-face`, no `<link>`; the app had been silently rendering in
`system-ui` the whole time) — to **Plus Jakarta Sans**, self-hosted.

- Two subset files in `static/fonts/` (latin 27KB, latin-ext 21KB), declared in
  `lib/design/fonts.css` as a **variable** font (`font-weight: 200 800`) with
  `font-display: swap` and the upstream `unicode-range`, so latin-ext is only
  fetched when a non-latin character appears.
- `app.html` preloads the latin subset (`crossorigin` is required for fonts even
  same-origin). Verified present in the served HTML.
- `DESIGN.md` (all six `fontFamily` declarations + the Typography prose) and
  `--fr-font-ui` updated; `theme.tailwind.css` regenerated from the spec.
- The drift test now guards typography as well: the non-mono scales must agree on
  one UI family, `--fr-font-ui` must start with it, an `@font-face` must declare
  it, every `@font-face` `src` must exist on disk, and every `font-weight` must be
  a range. **Verified the guard bites**: reverting `--fr-font-ui` to `Inter` fails
  two tests with an explicit message; restoring passes.

**Verified.** `svelte-check` 0/0; `vitest` **56/56**; build clean; the woff2 is
served `200 font/woff2` and copied into the build output; `document.fonts` shows one
face `loaded` (latin) and one `unloaded` (latin-ext, correct); body and `h1` compute
to `"Plus Jakarta Sans", …`; and the render proof (40px string) measures **408px**
in PJS vs **441.17px** in `system-ui`, so the webfont is genuinely rendering. Zero
console errors. Full regression after the metric change: axe **0 violations / 21
pages**, WCAG probe **0 findings** (focus / reflow@320 / touch / spacing), so the
different metrics broke no layout.

**Not verified by screenshot.** Asked to confirm the family visually, the vision
model correctly refused — modern system faces are themselves geometric humanist
sans, so "looks geometric" discriminates nothing. Its two layout complaints were
also both disproved by measurement: the name→slug gap is a real 3px (the first
probe's `0px` was a `Range` trailing-whitespace artifact), and `th`/`td` share
identical column edges.

**Open, not done:** numeric columns are `text-align: left` (inherited). Right-aligning
money and token figures is the usual completion of the tabular-figures rule and is
not mandated by `DESIGN.md` — a deliberate call to make, not a bug.

---

### 0.6 Type scale: a 12-step static/fluid ladder

The old scale was six compact steps (0.8125–2rem) chosen because "a console is read
in dense blocks". It was replaced with a full ladder that splits in two:

| Family | Steps | Behaviour |
| --- | --- | --- |
| Static text | `caption` `sm` `base` `lg` | fixed at every viewport |
| Fluid headings | `h6` `h5` `h4` `h3` `h2` `h1` `display` `display-xl` | `clamp()` from a floor to a ceiling |

Body copy that reflows because someone resized a window is hostile to read, so the
text steps never scale. The two smallest heading steps (`h6` 18px, `h5` 20px) are
static too — at that size fluidity buys nothing.

**Three decisions worth recording, because each one is a trap:**

1. **The spec format cannot express fluid type.** `@google/design.md` accepts only
   static dimensions (`px`/`em`/`rem`) — a `clamp()` is rejected as "not a valid
   dimension". So the frontmatter records each fluid heading's **floor**, the
   `clamp()` expressions live in DESIGN.md's typography table, and
   `tokens.test.ts` asserts the two agree. `tools/regen_theme.py` (since removed
   with the Svelte app, 2026-10-06 — it wrote the SvelteKit-only
   `theme.tailwind.css`) wrapped the official exporter and re-injected the real
   clamps into the Tailwind mirror, because `@theme` *is* CSS and a clamp is
   valid there.
2. **Heading elements map onto the lower half of the ladder** — `h1` renders at the
   `h4` step, `h2` at `h5`. The app is a dense console: `<h2>` is used for
   in-card section headings ("Add model", "Recent requests"), so mapping it to
   `--fr-text-h2` (32–40px) would have put a 40px headline inside a form card.
   The `h1`–`h3` and `display` steps are the content/marketing end; the landing
   hero uses `display`.
3. **Two tokens changed meaning, not just value.** `--fr-text-h2` went 18px →
   32–40px, and `--fr-text-body`/`--fr-text-label` were retired in favour of
   `--fr-text-base`/`--fr-text-caption`. `StatCard`'s KPI value was the only
   consumer of `--fr-text-h2`; it now sits at `--fr-text-h4` (24–25px), which is
   both a better KPI size and safe against the nowrap monospace values
   (`formatTokens` does not abbreviate — `1,234,567` is 9 characters).

**A real overflow was found by measuring, not by reading.** Bumping `sm` from 13px
to 14px pushed the `/models` endpoint URL (`https://ai.karepmuwes.my.id/coding/v1`,
38 characters, no spaces) past the 320px viewport by 16px — a flex item defaults to
`min-width: auto` and refuses to shrink below its content. Fixed with
`min-width: 0` + `overflow-wrap: anywhere` on `.endpoint`.

**Verification (all live, against the running build):**

```
type steps   h1 24→25px fluid · h2 20px static · hero display 40→60px · body 16px
tokens       12/12 resolve in the live document; --fr-text-label/body absent
reflow       0 overflowing / 20 routes @320px
StatCard     worst case "59,191" = 57.8px text in a 94px box → 36px headroom
axe          0 violations / 21 pages, 0 redirect mismatch
vitest       63/63 (was 56; +7 type-scale guards) · svelte-check 0/0 · eslint clean
revert-test  5 deliberate mutations → 5 caught, exactly 1 failure each
```

## 1. Goal

Split the control plane into three **audience surfaces** with one routing model,
one guard, and one capability map:

| Surface | Audience | Who | URL prefix |
|---|---|---|---|
| **Public** | anonymous | anyone | `/` (marketing, docs, auth) |
| **Member** | buyer / user | any authenticated account | `/dashboard`, `/keys`, `/usage`, `/billing`, `/account` |
| **Admin** | staff | `admin`, `finance_admin`, `ops_admin` | `/admin/*` |

"Member / user / buyer" is **one tier**: an authenticated customer. The `user`
role is that tier today; a future `plan`/entitlement gate is what separates a
free user from a paying buyer, not a separate route surface.

The deliverable is the routing + guard + page shell so every later slice (S1
routing, S2 billing, S3 programs, S6 ops) has a defined home instead of
inventing one.

---

## 2. Current state (measured, 2026-09-22)

| URL | Guard | Status |
|---|---|---|
| `/` | none | landing page (rewritten this session) |
| `/login`, `/signup` | none | working |
| `/keys` | `PROTECTED` | self-service keys |
| `/usage` | `PROTECTED` | own usage only |
| `/admin`, `/admin/providers`, `/admin/keys`, `/admin/requests`, `/admin/connections` | `PROTECTED` + `ADMIN_ONLY` + `assertAdmin` | shipped this session |

Gaps this plan closes:

- No **public marketing/docs** surface — `/` is the only anonymous page.
- Member pages live **at the root** with no member shell (no dashboard, no nav,
  no billing/account).
- Admin gate is a **hard `role === 'admin'`** check — `finance_admin` and
  `ops_admin` from spec §8 are defined but have **no route access** and no
  capability model.
- No **member dashboard** (overview), no **account** page, no **billing** page.

Schema available today (9 tables): `user, session, account, verification,
profile, api_key, provider, model, request_log`. Everything in Phase 1 below
reads only these — no S1/S2 dependency.

---

## 3. Role model & access matrix

Adopt spec §8's four roles and make them **capabilities**, not string equality.

```
user          → member
finance_admin → member, admin.view, admin.billing, admin.users(read)
ops_admin     → member, admin.view, admin.providers, admin.models, admin.requests, admin.ops
admin         → every capability
```

Unknown / null role → **`member` only** (fail closed; never admin).

| Route | Required capability | anon | user | finance_admin | ops_admin | admin |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `/`, `/pricing`, `/models`, `/docs`, `/status`, `/login`, `/signup` | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/dashboard`, `/keys`, `/usage`, `/account` | `member` | → login | ✅ | ✅ | ✅ | ✅ |
| `/billing` | `member` | → login | ✅ | ✅ | ✅ | ✅ |
| `/admin` | `admin.view` | → login | → `/` | ✅ | ✅ | ✅ |
| `/admin/users` | `admin.users` | → login | → `/` | ✅ (read) | → `/` | ✅ |
| `/admin/providers`, `/admin/models` | `admin.providers`/`admin.models` | → login | → `/` | → `/` | ✅ | ✅ |
| `/admin/requests`, `/admin/connections` | `admin.requests`/`admin.ops` | → login | → `/` | → `/` | ✅ | ✅ |
| `/admin/keys` | `admin.keys` | → login | → `/` | → `/` | → `/` | ✅ |
| `/admin/billing`, `/admin/transactions` | `admin.billing` | → login | → `/` | ✅ | → `/` | ✅ |
| `/admin/programs`, `/admin/settings`, `/admin/audit` | `admin.programs`/… | → login | → `/` | → `/` | → `/` | ✅ |

Non-admin authenticated users are sent to `/` (not `/login`) so they are never
bounced to a login form they are already past. Anonymous users go to `/login`.

---

## 4. Route architecture

SvelteKit **route groups** (`(name)`) give per-surface layouts and guards
**without changing any URL**. `(app)` and `(public)` are invisible in the path.

```
apps/web/src/routes/
  +layout.svelte              # global <html> chrome only (head, favicon)
  +layout.server.ts           # { user: {name,email,role} } for nav
  (public)/                   # → /  (no auth)
    +layout.svelte            # marketing chrome: header + footer
    +page.svelte              # /            landing
    pricing/+page.svelte      # /pricing
    models/+page.svelte       # /models      public catalog (from `model`)
    docs/+page.svelte         # /docs        API reference
    status/+page.svelte       # /status      (S6 real; placeholder P1)
    login/, signup/           # /login /signup (moved in)
    legal/{terms,privacy}/    # static
  (app)/                      # → /dashboard /keys /usage /account  (auth: member)
    +layout.server.ts         # redirect anon → /login
    +layout.svelte            # app chrome: sidebar (Dashboard, Keys, Usage, Billing, Account)
    dashboard/+page.*         # /dashboard   member overview
    keys/                     # /keys        (moved from /keys)
    usage/                    # /usage       (moved from /usage)
    account/+page.*           # /account     profile, password, danger zone
    billing/+page.*           # /billing     (P2 — needs S2)
  admin/                      # → /admin/*   (auth: admin.*)  — keep as-is
    +layout.server.ts         # requireCap('admin.view')  [NEW]
    +layout.svelte            # admin nav (filtered by capability)
    +page.*  providers/  keys/  requests/  connections/
    users/    models/         # P1
    revenue/  transactions/   # P2 (S2)
    programs/                 # P3 (S3)
    audit/    settings/       # P4 (S5/S6)
```

**URL stability:** `/keys` and `/usage` move *into* `(app)/` but keep their URLs
— a route group is not a path segment. No client bookmarks break.

---

## 5. Page inventory

### 5.1 Public

| URL | Purpose | Data source | Phase |
|---|---|---|---|
| `/` | Landing: value prop, endpoints, CTA | static | P1 |
| `/pricing` | Plan tiers + per-1M token prices | `model` prices; plan table in P2 | P1 (stub) / P2 |
| `/models` | Public model catalog | `model` where `status='active'` | P1 |
| `/docs` | [OI]-compatible API reference + curl examples | static | P1 |
| `/status` | Uptime / incidents | S6; static placeholder | P1 (stub) / P4 |
| `/login`, `/signup` | Auth | Better Auth | ✅ exists |
| `/legal/terms`, `/legal/privacy` | Static legal | static | P1 |

Public pages **never** render provider names, base URLs, or credentials — only
model slug/name/context/pricing.

### 5.2 Member

| URL | Purpose | Data source | Phase |
|---|---|---|---|
| `/dashboard` | Balance, spend MTD, requests, active keys, recent calls | `request_log` (own), `api_key`, S2 ledger | P1 (no balance) / P2 |
| `/keys` | Self-service keys, limits, revoke | `api_key` (own) | ✅ exists |
| `/usage` | Own usage totals + per-key breakdown | `request_log` (own) | ✅ exists (+ per-key add) |
| `/billing` | Balance, top-up, invoices, transactions | S2 ledger | P2 |
| `/account` | Name, email, password, timezone, danger zone | `user`, `profile` | P1 |
| `/playground` | Browser chat test against `/v1/chat/completions` | router :8100 | P2 (optional) |

### 5.3 Admin

| URL | Purpose | Capability | Phase |
|---|---|---|---|
| `/admin` | Counts, top consumers, recent calls | `admin.view` | ✅ exists |
| `/admin/providers` | Add/edit/delete providers, rotate credentials | `admin.providers` | ✅ exists |
| `/admin/keys` | Mint client key, per-key usage, limits | `admin.keys` | ✅ exists |
| `/admin/requests` | All calls across users | `admin.requests` | ✅ exists |
| `/admin/connections` | Per-provider traffic + live probe | `admin.ops` | ✅ exists |
| `/admin/users` | List, change role, ban/unban, impersonate | `admin.users` | P1 |
| `/admin/models` | CRUD models + pricing | `admin.models` | P1 |
| `/admin/revenue`, `/admin/transactions` | Ledger, top-ups, refunds | `admin.billing` | P2 (S2) |
| `/admin/programs` | Free credit, coding plan, referral | `admin.programs` | P3 (S3) |
| `/admin/audit` | Audit log of privileged actions | `admin.audit` | P4 (S5) |
| `/admin/settings` | Global flags, tunnel/domain config | `admin.settings` | P4 |

---

## 6. Guard strategy (three layers, fail-closed)

1. **`hooks.server.ts`** — classify `pathname` → required capability via a
   single `ROUTE_CAPS` table; redirect if the session lacks it. Anonymous →
   `/login`; authenticated-but-unauthorized → `/`.
2. **Per-route server `load`/`action`** — `requireCap(locals, cap)` (the
   existing `assertAdmin` generalised). Defense in depth so a re-ordering of the
   hook chain can never expose data.
3. **Data plane** — unchanged: the Go router re-enforces `/v1/*` independently.
   The control plane is not a security boundary for the hot path.

New module `apps/web/src/lib/server/roles.ts`:

```ts
export type Capability =
  | 'member' | 'admin.view' | 'admin.users' | 'admin.keys' | 'admin.providers'
  | 'admin.models' | 'admin.requests' | 'admin.ops' | 'admin.billing'
  | 'admin.programs' | 'admin.audit' | 'admin.settings';

const ROLE_CAPS: Record<string, Capability[]> = {
  user:          ['member'],
  finance_admin: ['member', 'admin.view', 'admin.billing', 'admin.users'],
  ops_admin:     ['member', 'admin.view', 'admin.providers', 'admin.models', 'admin.requests', 'admin.ops'],
  admin:         [ /* all */ ]
};

export function capsFor(role?: string | null): Set<Capability> { /* fail-closed → member */ }
export function hasCap(role: string | null | undefined, cap: Capability): boolean;
export function requireCap(locals: App.Locals, cap: Capability): void;  // error(403)
export function landingFor(role?: string | null): string;  // admin → /admin, else /dashboard
```

`hooks.server.ts` gets a `ROUTE_CAPS: [prefix, cap][]` table evaluated
longest-prefix-first, replacing the hard `ADMIN_ONLY` list.

---

## 7. Chrome per surface

| Surface | Nav |
|---|---|
| Public | `fudrouter` · Pricing · Models · Docs · Status · **Log in** / **Get started** |
| Member | sidebar: Dashboard · API Keys · Usage · Billing · Account · (Admin link iff `admin.view`) |
| Admin | secondary bar: Overview · Providers · Models · API Keys · Users · Requests · Connections · Billing* · Programs* · Audit* — **items filtered by the viewer's capabilities** |

`+layout.server.ts` exposes `role` + `caps` so nav renders per viewer without a
client round-trip.

---

## 8. Data-model deltas

Phase 1 needs **no migration** — it reads the existing 9 tables.

Deferred (owned by their slices, listed so the surfaces have a target):

- **S2:** `ledger_entry`, `transaction`, `invoice`, `payment_method` — powers
  `/billing`, `/admin/revenue`, `/admin/transactions`, and the dashboard balance.
- **S3:** `program`, `credit_grant`, `referral` — powers `/admin/programs`.
- **S5/S6:** `audit_log`, `feature_flag` — powers `/admin/audit`, `/admin/settings`.

`user.role` stays a single string (Better Auth admin plugin); the capability map
lives in code, so adding a role is a one-line change, not a migration.

---

## 9. Phasing

| Phase | Scope | Depends on |
|---|---|---|
| **P1** | Route groups + `roles.ts` + capability guard; move `/keys`,`/usage`; public landing/pricing-stub/models/docs; member `/dashboard`,`/account`; admin `/users`,`/models` | none (S0 schema only) |
| **P2** | `/billing` (member), `/admin/revenue`, `/admin/transactions`, dashboard balance | S2 |
| **P3** | `/admin/programs`, referral surface | S3 |
| **P4** | `/status`, `/admin/audit`, `/admin/settings`, `/admin/incidents` | S5/S6 |

P1 is fully buildable now. Later phases are **placeholders in the nav, gated
off** until their slice lands — no dead links (a capability with no page renders
nothing).

---

## 10. P1 tasks

**Files (new):** `src/lib/server/roles.ts`, `src/routes/(public)/**`,
`src/routes/(app)/**`, `src/routes/admin/{users,models}/**`,
`src/routes/admin/+layout.server.ts`
**Files (moved):** `src/routes/keys/**` → `src/routes/(app)/keys/**`;
`src/routes/usage/**` → `src/routes/(app)/usage/**`;
`src/routes/{login,signup}/**` → `src/routes/(public)/**`;
`src/routes/+page.svelte` → `src/routes/(public)/+page.svelte`
**Files (modified):** `src/hooks.server.ts` (ROUTE_CAPS), `src/routes/+layout.svelte`
(global chrome only), `src/routes/+layout.server.ts` (add `caps`)

- [x] **Task 1 — `roles.ts`.** Capability type, `ROLE_CAPS`, `capsFor` (fail-closed),
      `hasCap`, `requireCap`, `landingFor`. Vitest: unknown role → only `member`;
      every spec role maps to its caps; `admin` has all.
- [x] **Task 2 — capability guard in `hooks.server.ts`.** Replace `ADMIN_ONLY`
      with a `ROUTE_CAPS` longest-prefix table. Vitest (unit) for the classifier:
      `/admin/providers` → `admin.providers`; `/admin` → `admin.view`; `/keys` →
      `member`; `/pricing` → none.
- [x] **Task 3 — move pages into groups.** Relocate `/`, `/keys`, `/usage`,
      `/login`, `/signup`; `svelte-kit sync`; confirm **URLs unchanged**
      (`/keys` still 200 for a member, `/` still public). No import breakage.
- [x] **Task 4 — surface shells.** `(public)/+layout.svelte` (header/footer),
      `(app)/+layout.server.ts` (anon → `/login`) + `(app)/+layout.svelte`
      (sidebar), `admin/+layout.server.ts` (`requireCap('admin.view')`) +
      capability-filtered admin nav.
- [x] **Task 5 — public pages.** `/pricing` (stub from `model` prices), `/models`
      (active models only), `/docs` (endpoints + curl), `/legal/*`. Assert none
      leak provider names/URLs.
- [x] **Task 6 — member pages.** `/dashboard` (own counts, spend, recent — from
      `request_log`, no balance yet), `/account` (name/email/password/timezone
      via Better Auth + `profile`).
- [x] **Task 7 — admin pages.** `/admin/users` (list, role change, ban/unban via
      Better Auth admin plugin), `/admin/models` (CRUD + pricing, money as
      micro-units).
- [x] **Task 8 — verification.** See §11.

> **P1 implemented (2026-09-22).** Route groups `(public)` / `(app)` + `admin/`
> shipped with `$lib/server/roles.ts` (capability map, fail-closed) and a
> `ROUTE_CAPS` longest-prefix guard in `hooks.server.ts`. Public `/pricing`
> `/models` `/docs`; member `/dashboard` `/account`; admin `/users` `/models`.
> The five pre-existing admin pages were migrated from the hard `assertAdmin`
> check to `requireCap(<cap>)`. Verified: `svelte-check` 0 errors, 33 vitest
> tests pass, build clean, and a 4-tier HTTP smoke (anon/user/finance_admin/
> ops_admin/admin) all green.

---

## 11. Verification (P1 acceptance)

- `npm run check` → 0 errors; `npm run test` → green (new role/classifier tests included).
- `npm run build` → succeeds; `pm2 restart fudrouter-web` → `online`, :3000 bound.
- **Tier smoke** (Playwright + cookie injection, per `fudrouter` skill):
  - anon: `/`, `/pricing`, `/models`, `/docs` → 200; `/keys`, `/dashboard`, `/admin` → 303 `/login`.
  - `user`: `/dashboard`, `/keys`, `/usage`, `/account` → 200; `/admin` → 303 `/`.
  - `finance_admin`: `/admin`, `/admin/billing` → 200; `/admin/providers` → 303 `/`.
  - `ops_admin`: `/admin`, `/admin/providers`, `/admin/connections` → 200; `/admin/keys` → 303 `/`.
  - `admin`: all `/admin/*` → 200.
- Extend `scripts/e2e-smoke.mjs` to assert the member dashboard renders a
  `request_log` row the walking skeleton produced.

---

## 12. Risks & pitfalls

| Risk | Mitigation |
|---|---|
| Route-group move breaks `$types` / imports | `svelte-kit sync` after the move; `npm run check` is the gate; URLs are unchanged so links/bookmarks survive |
| Hard `role === 'admin'` misses `finance_admin`/`ops_admin` | Capability map, not equality; fail-closed default |
| Public page leaks provider internals | Public loads select only model fields; a test asserts no `base_url`/credential in public HTML |
| **CSRF/ORIGIN trap** | adapter-node derives `event.url` from `ORIGIN`; form POSTs from `127.0.0.1:3000` are rejected. Test via the ORIGIN host or send `Origin: https://ai.karepmuwes.my.id` (documented in the `fudrouter` skill) |
| **Tunnel gap** | `ai.karepmuwes.my.id` ingress is currently **removed** — the public/member surfaces are not reachable externally until it is restored. Restoring the ingress is a prerequisite for any external launch, not for P1 dev work |
| Nav shows dead links for unbuilt phases | Capability with no page renders nothing; placeholders are gated, not stubbed |
| `/dashboard` promising a balance before S2 | P1 dashboard shows usage/counts only; balance is added in P2 with the ledger |

---

## 13. Open questions

1. **Member tier naming** — keep the role literally `user`, or introduce a
   `member`/`buyer` alias for the UI? (Recommendation: keep `user` in the DB,
   label it "Member" in the UI.)
2. **Public pricing** — hardcode plan tiers in P1, or derive from `model` prices
   only until S2/S3 define plans?
3. **Playground** — in scope for P2, or drop it (the docs curl examples may be
   enough)?
4. **Impersonation** — expose Better Auth's impersonate in `/admin/users` in P1,
   or defer to the audit-log slice (P4) so impersonation is always logged?
