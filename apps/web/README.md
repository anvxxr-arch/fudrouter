# @fudrouter/web

The SvelteKit control plane. See the [root README](../../README.md) for how this
fits with the Go data plane.

## `src/lib` — the parts worth knowing

```
lib/
  ui/           one .svelte per design-system atom; import from the barrel
  design/       tokens.css (Tier-1 primitives + Tier-2 semantic roles),
                components.css (shared atoms: .fr-btn, .fr-control, .fr-tone-*),
                theme.tailwind.css  ◀ GENERATED, do not hand-edit
  guides-types.ts  the Guide contract
  guides/       explanatory copy, one file per audience
  server/       server-only code (never imported from a .svelte)
    db/            drizzle schema + pool
    provider-*.ts  upstream catalog fetch, credential helpers, sandbox chat
  publish.ts    the PURE reachability rule (unit-tested)
```

### The design system

Tokens are two tiers by design. Tier 1 names what a value **is**
(`--color-orange`); Tier 2 names what it is **for** (`--primary`) and is the only
tier a component reads. There are deliberately few Tier-2 tokens: one earns its
place only when it names a decision a rebrand could make differently.

`theme.tailwind.css` is generated from the spec in `DESIGN.md` by
`tools/regen_theme.py`. Editing `DESIGN.md` without regenerating used to drift
silently, so `regen_theme.py --check` is in CI and fails on a mismatch:

```sh
python3 ../../tools/regen_theme.py          # regenerate
python3 ../../tools/regen_theme.py --check  # verify (what CI runs)
```

### Server/client boundary

`$lib/server/*` must never be imported from a `.svelte` file or a client-side
utility. Two kinds of module live there and the distinction matters:

- **Stateful** — auth, db, credentials, ssrf, provider calls. Import
  `$env/dynamic/private` and cannot be imported by a unit test outside the
  SvelteKit runtime.
- **Pure helpers** — `rate-limit.ts`, `admin-limits.ts`, `provider-status.ts`,
  `keys.ts`. No `$env` import, so they are plain unit-tested modules that happen
  to be admin/server-facing by concern.

`$lib/publish.ts` (pure rule) and `$lib/server/publish-env.ts` (the two env
reads) are split for exactly that reason: folding them together would either cost
the rule its test coverage or force every test to boot a server.

### Route groups

| Group              | Surface                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `routes/(public)/` | Marketing. No session, no capability gate                                                       |
| `routes/(app)/`    | Member. `+layout.server.ts` requires a session, then `member`                                   |
| `routes/admin/`    | Staff. `+layout.server.ts` requires `admin.view`, and every action re-checks its own capability |

Capability gating is a table lookup in `$lib/server/roles.ts` — longest matching
prefix wins. Adding an admin surface means one line there plus the `requireCap`
call in the page; there is no literal role string anywhere in a route.

## Commands

```sh
npm run check       # svelte-kit sync + svelte-check (typed .svelte + .ts)
npm run lint        # prettier --check . && eslint .
npm test            # vitest
npm run db:check    # drizzle-check: schema matches the migrations
npm run build       # vite build → build/ (adapter-node)
```

Tests are `*.test.ts` next to the module they cover. `provider-catalog.test.ts`
and `admin-limits.test.ts` are the ones that pin the upstream-input contract.
