# ADR-0004 — Declared stack vs repository reality

- **Status:** PROPOSED
- **Date:** 2026-10-10

## Context

The mission brief declares an "approved stack". Five items are already true, four are not. Confusing the two would produce a migration that "adopts" things that exist and silently invents things that do not.

## Findings

| declared | repository | verdict |
|---|---|---|
| React + TypeScript | React 19.1, TS 5.9 | **already true** |
| Go inference gateway | `services/router`, 7 routes, SSE | **already true** |
| PostgreSQL | 15 migrations, 42 tables | **already true** |
| Valkey | `ioredis` + `internal/vk`/`internal/limits` | **already true** |
| Discord OAuth 2.0 | `better-auth` `socialProviders.discord` → `/api/auth/callback/discord` | **already true** |
| Bun | Node `>=22.5` + npm workspaces; `bun` appears only in `.gitignore` | **not adopted** |
| TanStack Router (file-based) | `react-router-dom ^7.6.0`, 11 flat route modules | **not adopted** |
| Go management API | Express 5 owns management | **not present** (ADR-0002) |
| Rust workers | nothing | **not present** (ADR-0003) |

## Decision

Split the stack question into adoption decisions, each separately approvable and separately reversible:

1. **Bun — DEFER.** Nothing in the repo requires it. Adopting it means: re-proving `npm workspaces` behaviour, re-checking `better-auth`/`drizzle`/`express` under the Bun runtime, and re-validating the 3 PM2 entrypoints that boot Node processes. The only current benefit is install/test speed. **Adopt only with a measured need.**
2. **TanStack Router — EVALUATE, do not adopt during the layout migration.** It is a rewrite of the 11 route modules plus `guards.tsx`, and the brief also requires a *shared navigation registry* and three layouts. Those should be built once, on the router that survives. Sequence: decide the router → then build nav/layouts.
3. **Go management API — do not build** (ADR-0002).
4. **Rust workers — do not build** (ADR-0003).
5. **Discord OAuth — treat as load-bearing already.** The brief lists it as a stack item; it is shipped, so it is in the "must not break" set, alongside streaming, billing, and sessions.

## Consequences

- The migration's real content is **structure + contracts + tests**, not stack replacement. That is consistent with the brief's own execution order (Phase 0 inspection → contracts/baseline → structure → incremental refactor).
- Any Bun/TanStack adoption becomes a separate ADR with its own measurements, so a failure there cannot be entangled with the layout rollback.
- One production-config nit is recorded rather than changed: `server/index.mjs:404` sets `trustedOrigins: []` when `NODE_ENV=production`. Changing it is a production config change and needs explicit approval.

## Alternatives rejected

- **Adopt Bun + TanStack in the same change as the restructure.** Two coupled rewrites sharing one rollback: if either regresses streaming or OAuth, neither can be reverted independently.
- **Treat the declared stack as a mandate to implement everything.** Directly contradicts "do not invent implementations for unavailable features" and "do not rewrite from scratch".

## Evidence

Gap register §A; `apps/react-web/package.json`; root `package.json`; `.gitignore`; `apps/react-web/server/index.mjs:372-426`.
