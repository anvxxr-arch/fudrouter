# fudrouter

Commercial AI router — one API key, many model providers.

- `apps/web` — SvelteKit control plane (UI, auth, billing, admin)
- `services/router` — Go data plane (`/v1/chat/completions` hot path)
- `packages/contracts` — shared types for the web ↔ router contract
- `infra/` — docker-compose (Postgres 17 + Valkey) and migrations
- `docs/specs` — design specs

Dev stack: `docker compose -f infra/docker-compose.yml up -d`
