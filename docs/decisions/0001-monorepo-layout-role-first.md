# ADR-0001 — Monorepo layout: role-first, domain-first inside the Go module

- **Status:** PROPOSED — requires explicit approval before any file moves
- **Date:** 2026-10-10
- **Deciders:** Dwi (owner), Fox (lead architect)

## Context

Two layouts are on the table and they are not the same tree.

- **Mission brief (tech-first at the top):** `apps/web`, `backend/go/**`, `backend/rust/**`, `packages/{contracts,ui,config}`, `infra/{containers,deploy,scripts}`, `docs/**`, `tests/{integration,e2e,load}`.
- **Design session (role-first, 6 top-level dirs):** `apps/{console,router,workers,scheduler}`, `packages/<lib>`, `ops/` (+`ops/verify/`), `db/`, `docs/`.

The repository today has 11 top-level directories, of which only `apps/` is a real workspace member: `apps, audit, docs, infra, scratch, scripts, services, shared, tools, .github, .superpowers`. The workspace glob `packages/*` is declared and empty.

Industry sources agree on the shape: Turborepo — *"`apps/` for applications **and services** and `packages/` for everything else, like libraries and tooling"*, and nested globs are unsupported; reopt — *"Avoid generic names such as common, `shared`, or utils unless scope is very clear"*; the monorepo playbook — `shared`/`common`/`utils`/`core` are named smells and *"deep imports are always forbidden"*.

## Decision

1. **Top level is role-first** (the design session's Target B): every directory answers *"what is this for"* — `apps/` = deployable, `packages/` = importable, `ops/` = operations, `db/` = schema, `docs/` = prose.
2. **Inside the Go module, names are domain-first** (the brief's intent): `internal/<domain>` rather than `internal/<mechanism>` — but only for domains that exist. Renames happen when the domain boundary is real, never as empty scaffolding.
3. **`backend/go` + `backend/rust` are rejected as top-level** for now: with zero Rust source they encode a stack decision that has not been made, and `backend/` as a wrapper around `apps/` duplicates the by-role axis.

## Consequences

- Positive: one rule per directory; no `shared`/`services`/`infra` ambiguity; `packages/*` finally resolves.
- Positive: the Go module keeps `go.mod` at its root, so the module path change is the only cross-cutting edit.
- Negative: diverges from the brief's literal target root; `git mv` churn across ~200 files.
- Negative: domain-first Go names require a real review of `internal/proxy` (8,880 LOC) — that file is both the HTTP surface and the orchestration, so splitting it is a behaviour-risk, not a rename.

## Alternatives rejected

- **Literal brief layout.** Would create `backend/rust/crates/{worker,workflow,contracts}` and 14 `internal/{…}` domain dirs with no code — directly against the brief's own "no unnecessary empty scaffolding".
- **Keep `services/` and `shared/`.** Both are named smells in two independent sources, and `shared/control-lib` has no `package.json`, so the name is not the only problem.

## Evidence

`docs/architecture/2026-10-10-dependency-graph.md` §1, §5; Turborepo docs (structuring a repository); reopt Handbook (workspace design); monorepo-architecture-playbook.
