# ADR-0003 — Rust async workers: out of scope until measured

- **Status:** PROPOSED
- **Date:** 2026-10-10

## Context

The brief's approved stack names *"Rust asynchronous workflow/agent workers"* and the target root reserves `backend/rust/crates/{worker,workflow,contracts}`.

Repository reality:

- **0** `Cargo.toml`, **0** `.rs` files.
- The worker fleet is Node: `scripts/workers.mjs` (PM2 app `fudrouter-workers`, `WORKER_CONCURRENCY=4`, `FOR UPDATE SKIP LOCKED` claim loop) and `scripts/scheduler.mjs` (PM2 app `fudrouter-scheduler`, the only producer of recurring `job` rows, single-instance via a Valkey lock).
- Both run on `shared/control-lib` (`server/jobs.ts`, `server/workers.ts`, `server/scheduler.ts`) against the `job` table.
- There is **no workflow engine and no agent runtime** to port (see the gap register §C).

The brief also says: *"Do not rewrite the application from scratch"*, *"Do not invent implementations for unavailable features"*, and *"Keep Rust off the synchronous inference path unless justified by measurements."*

## Decision

1. **Do not create `backend/rust/**` in this migration.** An empty crate tree is exactly the "unnecessary empty scaffolding" the brief forbids.
2. **Keep the Node worker fleet as the system of record** for jobs. It works, it is supervised, and it owns the drain semantics (`kill_timeout > drain`, never abandoning a `running` row).
3. A Rust worker becomes admissible **only** with (a) a measured bottleneck the Node fleet cannot meet, and (b) a versioned job/result/event contract (ADR-0005) so the two runtimes can be interleaved and rolled back.

## Consequences

- Positive: no runtime is added to a box that is 4 cores and already runs 4 PM2 apps + Postgres + Valkey + Caddy.
- Positive: the brief's own "measurements first" rule is honoured rather than pre-empted.
- Negative: `backend/rust/crates/{worker,workflow,contracts}` in the target root stays unbuilt, and the Go↔Rust job/result/event schemas cannot be specified yet.
- Neutral: if Rust is introduced later, the ops surface (`ops/`) and the process supervisor are already language-agnostic — PM2 only needs another `run.sh`-style entrypoint.

## Alternatives rejected

- **Create the crate tree now with stub crates.** Violates "no unnecessary empty scaffolding", and stub crates silently become the design.
- **Port workers.mjs/scheduler.mjs to Rust as part of the migration.** A rewrite of working production code with no test coverage to prove parity — the highest-risk item available, for no measured gain.

## Evidence

`find . -name Cargo.toml` → 0; `find . -name '*.rs'` → 0; `ecosystem.config.cjs` (workers/scheduler apps); `scripts/workers.mjs`, `scripts/scheduler.mjs`; gap register §C (no workflow/agent feature exists).
