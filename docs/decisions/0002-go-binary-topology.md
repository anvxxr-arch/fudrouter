# ADR-0002 — Go binary topology: keep one inference binary

- **Status:** PROPOSED
- **Date:** 2026-10-10

## Context

The brief asks for `backend/go/cmd/{api,gateway,migrate}` — three Go binaries.

Reality:

- `services/router/main.go` is **132 lines**: build mux, `http.Server`, graceful shutdown. It serves **only** the inference surface: `GET /health`, `GET|/v1/models`, `GET /v1/models/`, `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/messages/count_tokens`, and the `/v1/` catch-all.
- **No management route exists in Go.** Management is Express 5: `apps/react-web/server/admin.mjs` exposes 40+ `/api/admin/*` endpoints, with `better-auth` owning sessions and `drizzle` owning the schema.
- **`migrate` is not Go.** `scripts/migrate.sh` applies `infra/migrations/*.sql` in lexical order via `psql`.

So `cmd/api` and `cmd/migrate` would be **new Go programs**, not a relocation of existing ones. Building them means inventing implementations the brief explicitly forbids inventing, and re-implementing auth/session/RBAC that currently works.

## Decision

1. **Keep a single Go binary** — `apps/router` — owning the inference hot path, with `main.go` at the module root. Go's own guidance allows this: `cmd/` is *"a common convention"* for repositories that have many non-Go directories, not a requirement, and a single-command module at the root is idiomatic.
2. **Do not create `cmd/api` or `cmd/migrate`.**
3. If the Go side ever grows a second command, adopt `cmd/<name>/main.go` **then** — the module is already laid out (`main.go` + `internal/`) so the move is mechanical.

## Consequences

- Positive: no rewrite of 40+ working admin endpoints; no dual auth stacks.
- Positive: PM2's `fudrouter-router` app, its `run.sh`, `ROUTER_ADDR`, `ROUTER_TRUSTED_PROXIES` and 25s `kill_timeout` all stay valid.
- Negative: the "Go management API" line in the approved stack remains **unimplemented**. That is a product decision, and it must be taken deliberately — it is not part of a layout migration.
- Negative: two languages (Go + TS) keep reading the same 42 tables directly (dependency-graph V10).

## Alternatives rejected

- **Port the admin API to Go.** A rewrite of 2,742 lines of `admin.mjs` plus the auth stack, with no test suite capable of proving parity (V9: no integration/E2E). Unacceptable under "do not break billing, streaming, OAuth sessions".
- **New Go `gateway` binary + keep Express as `api`.** Only sensible if the two must scale or deploy independently; no measurement supports that today.

## Evidence

`services/router/main.go` (132 lines); `internal/proxy/proxy.go` `ServeMux`; `apps/react-web/server/admin.mjs`; `scripts/migrate.sh`; go.dev "Organizing a Go module".
