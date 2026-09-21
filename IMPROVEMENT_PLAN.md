# Fudrouter Improvement Plan

## Phase 1: Security Hardening

### 1.1 Fix `API_KEY_SECRET` enforcement
- **File:** `internal/apikey/apikey.go`
- **Change:** Fail startup if `API_KEY_SECRET` env var is not set
- **Impact:** Prevents hardcoded secret exploitation

### 1.2 Hash API keys at rest
- **File:** `internal/db/crud.go`
- **Change:** Store SHA-256 hash of API keys, compare on auth
- **Impact:** Protects keys if DB is compromised

### 1.3 Restrict CORS
- **File:** `internal/api/api.go`
- **Change:** Read `ALLOWED_ORIGINS` env var, default to `http://localhost:8012`
- **Impact:** Prevents unauthorized cross-origin requests

### 1.4 Add rate limiting
- **File:** `internal/api/api.go` (new middleware)
- **Change:** Token bucket per IP/API key, configurable via env
- **Impact:** Prevents abuse and quota exhaustion

### 1.5 Fix OAuth state
- **File:** `internal/oauth/xai.go`, `internal/oauth/codex.go`
- **Change:** Use `oauth.RandomState()` instead of session ID
- **Impact:** Prevents CSRF attacks on OAuth flow

### 1.6 Add graceful shutdown
- **File:** `cmd/fudrouter/main.go`
- **Change:** Drain in-flight requests on SIGTERM
- **Impact:** Prevents request loss during deployment

### 1.7 Add structured logging
- **File:** `cmd/fudrouter/main.go`, `internal/oauth/refresh.go`
- **Change:** Replace `log.Printf` with `slog` JSON output
- **Impact:** Better observability and log aggregation

### 1.8 Add request ID propagation
- **File:** `internal/api/api.go`
- **Change:** Generate/propagate `X-Request-ID` header
- **Impact:** Enables distributed tracing

---

## Phase 2: Provider Abstraction Layer

### 2.1 Define Provider interface
- **File:** `internal/provider/provider.go` (new)
- **Change:** Create `Provider` interface with common methods
- **Impact:** Adding a new provider = 1 file

### 2.2 Implement Provider registry
- **File:** `internal/provider/registry.go` (new)
- **Change:** Dynamic provider registration, no hardcoded list
- **Impact:** Eliminates `providerMeta` map in `complete.go`

### 2.3 Refactor chat engine to use Provider interface
- **File:** `internal/chat/engine.go`
- **Change:** Route through Provider interface instead of direct HTTP
- **Impact:** Cleaner separation of concerns

### 2.4 Add provider health checks
- **File:** `internal/provider/health.go` (new)
- **Change:** Per-provider health status endpoint
- **Impact:** Better visibility into provider availability

### 2.5 Add provider metrics
- **File:** `internal/provider/metrics.go` (new)
- **Change:** Prometheus metrics per provider
- **Impact:** Cost and performance tracking

---

## Execution Order

1. Phase 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8
2. Phase 2.1 → 2.2 → 2.3 → 2.4 → 2.5

Each change will be verified with `go build` before moving to the next.
