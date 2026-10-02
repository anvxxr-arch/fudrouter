# Fudrouter

**One API for every provider.**

Fudrouter is a unified AI API gateway that routes requests to 30+ AI providers through a single OpenAI-compatible endpoint. It supports OpenAI, Anthropic, Google, xAI, Codex, Kiro, Cursor, Qoder, Xiaomi, and more.

## Features

- **Unified API**: One endpoint (`/v1/chat/completions`) for all providers
- **OAuth Support**: PKCE, device flow, social auth, ECDH
- **MITM Proxy**: Intercept and transform requests/responses
- **Provider Abstraction**: Clean interface for adding new providers
- **Protocol Normalization**: SSE, request/response transformers
- **Performance**: Connection pooling, caching, circuit breaker, request coalescing
- **Observability**: Prometheus metrics, distributed tracing, health checks
- **Security**: API key hashing, CORS, rate limiting, TLS
- **Operational**: Docker, CI/CD, DB migrations, backup/restore

## Quick Start

### Docker

```bash
cp .env.example .env
# Edit .env and set API_KEY_SECRET
docker compose up --build
```

### Binary

```bash
go build -o fudrouter ./cmd/fudrouter
export API_KEY_SECRET="your-secret-here"
./fudrouter
```

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `API_KEY_SECRET` | (required) | Secret for API key generation |
| `FUDROUTER_API_ADDR` | `0.0.0.0:8011` | API server address |
| `FUDROUTER_WEB_ADDR` | `0.0.0.0:8012` | Web UI address |
| `FUDROUTER_MITM_ADDR` | `:8443` | MITM proxy address |
| `FUDROUTER_ENV` | `production` | Environment (production/development) |
| `ALLOWED_ORIGINS` | `http://localhost:8012` | CORS allowed origins |
| `RATE_LIMIT_RATE` | `10` | Rate limit tokens per second |
| `RATE_LIMIT_CAPACITY` | `50` | Rate limit burst capacity |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Chat completions (OpenAI-compatible) |
| `GET /api/health` | Health check |
| `GET /api/providers` | List providers |
| `GET /api/connections` | List connections |
| `POST /api/connections` | Create connection |
| `GET /api/keys` | List API keys |
| `POST /api/keys` | Create API key |
| `GET /api/usage/stats` | Usage statistics |
| `GET /api/usage/history` | Usage history |
| `GET /api/logs/stream` | Live log stream (SSE) |
| `GET /metrics` | Prometheus metrics |
| `GET /api/metrics` | JSON metrics |
| `GET /api/providers/health` | Provider health checks |
| `GET /api/traces` | Distributed trace spans |

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │         API Gateway (:8011)          │
                    │  ┌─────────┐  ┌─────────┐  ┌──────┐ │
                    │  │  Auth   │  │  Rate   │  │ Cache│ │
                    │  │ Middleware│ │ Limiter │  │ Layer│ │
                    │  └────┬────┘  └────┬────┘  └──┬───┘ │
                    │       └─────────────┴──────────┘     │
                    │              │                        │
                    │       ┌──────┴──────┐                 │
                    │       │   Router    │                 │
                    │       │  (provider  │                 │
                    │       │   selector) │                 │
                    │       └──────┬──────┘                 │
                    │              │                        │
                    │  ┌───────────┼───────────┐            │
                    │  │           │           │            │
                    │  ▼           ▼           ▼            │
                    │ ┌────┐   ┌────┐   ┌────┐             │
                    │ │Open│   │Anth│   │Goog│  ... 30+     │
                    │ │AI  │   │ropic│   │le  │             │
                    │ └────┘   └────┘   └────┘             │
                    └─────────────────────────────────────┘
```

## Development

```bash
# Build
make build

# Test
make test

# Run
make run

# Docker
make docker
```

## License

MIT
