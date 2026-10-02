# legacy/ — retired code kept inside the monorepo

`fudrouter-app/` is the **first-generation** fudrouter: a personal MITM AI
router (Go + SQLite + Next.js dashboard) that intercepted AI-coding-tool traffic
by hijacking `/etc/hosts` and listening on port 443. It was **decommissioned in
S0-A (2026-09-21)** and superseded by the commercial router in `apps/web`
(SvelteKit control plane) + `services/router` (Go data plane).

It is kept here — inside the monorepo, not as a second repository — so the whole
product's history lives in one place. Its original git history was folded in
with `git subtree add` (5 commits, 2026-09-21); see
`docs/decommission-log.md`.

**Nothing in this directory is built, tested, or deployed.** The CI jobs are
scoped to `apps/web` and `services/router`, and the root npm workspaces cover
only `apps/*` and `packages/*`, so `legacy/*` is inert.

**Do not run it.** It needs root, port 443 and `/etc/hosts` edits. The original
tarball backup remains at
`/home/dwizzy/backups/fudrouter-app-20260921-112609.tar.gz`; the decommission
log carries the rollback path for archaeology.
