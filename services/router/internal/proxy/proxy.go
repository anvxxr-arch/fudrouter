// Package proxy serves the [OI]-compatible hot path (PRD §85 request
// lifecycle).
//
// One lifecycle for every endpoint (§85): authenticate → limits → budget →
// resolve model → route → attempt(s) → record → charge. The two public entry
// points (ServeCompletions for chat, ServeGeneric for the rest) differ only in
// body handling and the freebuff dispatch; everything else is shared machinery
// in lifecycle.go.
package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/freebuff"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/limits"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/routing"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/vk"
)

type Handler struct {
	store     *store.Store
	crypt     *crypt.Crypt
	client    *http.Client
	refresher TokenRefresher

	// freebuff drives the native Codebuff/Freebuff protocol for providers whose
	// connection config declares protocol="freebuff".
	freebuff *freebuff.Manager

	// limiter enforces the spec §7 limit chain (Valkey fast path, S0 in-process
	// fallback, fail-open on a cache outage).
	limiter *limits.Limiter

	// vk is the cache/counter layer (spec §12): budget counters, circuit state.
	vk vk.Client

	// breaker holds routing circuit state (spec §9); config comes from the
	// circuit_breaker table and is refreshed with the routing policy.
	breaker *routing.CircuitBreaker

	// pools caches one rotation Pool per credential target. The pool is the
	// in-memory source of truth for account state once built, because it is
	// also the writer of the persisted secret.
	pools sync.Map // target key -> *Pool

	// showCostMeta gates the cost metadata response headers (PRD §90). Default
	// off: pricing is not disclosed per-request unless explicitly enabled.
	showCostMeta bool
}

// New builds the hot-path handler. A nil refresher disables token refresh,
// which is only correct for providers using a static api_key.
func New(st *store.Store, cr *crypt.Crypt, client *http.Client, refresher TokenRefresher, c vk.Client) *Handler {
	if client == nil {
		client = newUpstreamClient()
	}
	if c == nil {
		c = vk.Disabled()
	}
	// Read once at construction (main calls New once): the reload window for
	// credential pools. Tests set poolReloadAfter directly and are unaffected.
	poolReloadAfter = time.Duration(poolReloadSeconds()) * time.Second
	return &Handler{
		store:        st,
		crypt:        cr,
		client:       client,
		refresher:    refresher,
		freebuff:     freebuff.New(os.Getenv("FREEBUFF_BASE_URL")),
		limiter:      limits.New(c),
		vk:           c,
		breaker:      routing.NewCircuitBreaker(c, nil),
		showCostMeta: strings.EqualFold(os.Getenv("ROUTER_COST_HEADERS"), "on"),
	}
}

// ServeMux returns the complete public route table for these components.
//
// The exact patterns MUST be registered before the catch-all. `/v1/` matches
// "/v1/models" as a subtree, so dropping the exact pattern silently hands the
// catalogue to ServeGeneric — which bills and forwards instead of answering.
//
// `GET /v1/models/` is the /v1/models/{model} handler (endpoint-surface spec
// §6 P1): a published slug answers with one model object, anything else 404s
// truthfully. Public like /v1/models (spec §2.1: the catalogue is not a
// protected resource).
func ServeMux(p *Handler, health http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("GET /health", health)
	mux.Handle("GET /v1/models", http.HandlerFunc(p.ServeModels))
	mux.Handle("GET /v1/models/", http.HandlerFunc(p.ServeModel))
	mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))
	// The Anthropic Messages API as a native surface (anthropic.go): an
	// Anthropic-shaped client — [CC], the SDKs, Cursor's Anthropic mode — can
	// point at the router unchanged. Registered before the /v1/ catch-all for
	// the same reason as the chat route above.
	mux.Handle("POST /v1/messages", http.HandlerFunc(p.ServeMessages))
	mux.Handle("POST /v1/messages/count_tokens", http.HandlerFunc(p.ServeCountTokens))
	mux.Handle("/v1/", http.HandlerFunc(p.ServeGeneric))
	return mux
}

// newUpstreamClient builds the client used for plain [OI] passthrough.
//
// It deliberately carries NO overall Timeout: http.Client.Timeout bounds the
// whole exchange INCLUDING the response body, so any value cut streaming
// completions mid-answer. Liveness is bounded per phase (dial/TLS/response
// header) and per request by the caller's context / routing deadline.
func newUpstreamClient() *http.Client {
	// The dial guard is what makes base_url safe to trust: it rejects any
	// target that resolves into loopback/RFC1918/link-local/CGNAT — including a
	// redirect hop, because every redirect dials through this same transport.
	dialer := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   dialControl(allowPrivateUpstreams()),
	}
	return &http.Client{
		CheckRedirect: guardedRedirectPolicy,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			// Go's per-host idle default is 2: without this, concurrent
			// requests to the same upstream serialize on dials while the
			// global pool sits mostly empty.
			MaxIdleConnsPerHost:   20,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 120 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

// genericTimeout bounds the non-streaming body read on the generic /v1/* path.
// Sized like the chat path's bound: a non-streaming upstream answer that has
// not finished inside two minutes is a dead upstream, not a slow one. A stream
// is exempt — no timer is armed for it. A var so a test can shorten it.
var genericTimeout = 120 * time.Second

// nonStreamTimeout bounds a non-streaming completion end to end. A stream has
// no such bound: it is governed by the client's own connection.
const nonStreamTimeout = 120 * time.Second

// poolReloadAfter bounds how long a built pool is trusted. The stored secret
// can be rewritten from outside this process — an import, a maintenance
// rotation — and a pool that never reloads keeps serving tokens that were
// rotated away. A var so a test can exercise the reload without sleeping.
var poolReloadAfter = time.Minute

// poolReloadSeconds reads ROUTER_POOL_RELOAD_S (default 60): how long a
// built credential pool is trusted before it reloads the stored secret. A
// large farm churns secrets on rotation, so the window is tunable without a
// redeploy; <=0 or unparseable falls back to the default.
func poolReloadSeconds() int {
	if s, ok := os.LookupEnv("ROUTER_POOL_RELOAD_S"); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
			return n
		}
	}
	return 60
}

// headers a stored default_header may never override.
//
// Beyond the three that break the request outright (authorization, content-type,
// host) this blocks the standard hop-by-hop set (RFC 7230 §6.1: connection,
// keep-alive, proxy-authenticate, proxy-authorization, te, trailer,
// transfer-encoding, upgrade) — a provider default_header that set `te` or
// `transfer-encoding` would desynchronise the upstream exchange — and the
// forwarding-sensitive headers that describe the CLIENT's connection
// (x-forwarded-for, x-forwarded-host, x-forwarded-proto, forwarded, x-real-ip)
// plus the router's own identity headers (x-fudrouter-*), which a provider
// must never be able to forge into the client's response.
var reservedHeaders = map[string]bool{
	"authorization":          true,
	"content-type":           true,
	"host":                   true,
	"connection":             true,
	"keep-alive":             true,
	"proxy-authenticate":     true,
	"proxy-authorization":    true,
	"te":                     true,
	"trailer":                true,
	"transfer-encoding":      true,
	"upgrade":                true,
	"x-forwarded-for":        true,
	"x-forwarded-host":       true,
	"x-forwarded-proto":      true,
	"forwarded":              true,
	"x-real-ip":              true,
	"x-fudrouter-request-id": true,
	"x-fudrouter-provider":   true,
	"x-fudrouter-model":      true,
	"x-fudrouter-latency":    true,
	"x-fudrouter-cost-micro": true,
}

// responseHeadersForwarded is an ALLOWLIST of upstream response headers copied
// to the client. A blacklist leaks every new header an upstream or its CDN
// invents; the generic passthrough used to forward all of them.
var responseHeadersForwarded = map[string]bool{
	"content-type":  true,
	"retry-after":   true,
	"cache-control": true,
}

// copyUpstreamHeaders relays only the allowlisted headers, so hop-by-hop and
// upstream-identity headers never reach the client.
func copyUpstreamHeaders(w http.ResponseWriter, src http.Header) {
	for k, vv := range src {
		if !responseHeadersForwarded[strings.ToLower(k)] {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
}

// writeErr answers with the normalized [OI] error envelope (PRD §88):
// {"error":{"message","type","code"}} where code is the taxonomy code. The
// request id and latency headers are already on w when this runs, so a client
// can correlate an error with its request_log row.
func (h *Handler) writeErr(w http.ResponseWriter, e apiError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"message": e.Message, "type": e.Type, "code": e.Code},
	})
}

// writeErrCode is the convenience form: taxonomy code + optional message.
func (h *Handler) writeErrCode(w http.ResponseWriter, code, message string) {
	h.writeErr(w, normalize(code, message))
}

// ServeCompletions is the native chat hot path (PRD §85): full lifecycle with
// streaming, usage capture and billing on every outcome.
func (h *Handler) ServeCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	// Body first on this path only: chat is a model-addressed endpoint and the
	// model string drives routing. Validation runs INSIDE begin, after auth —
	// an invalid key must be 401 regardless of the body (endpoint-surface
	// spec §3.1: auth is evaluated before path support).
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		h.writeErrCode(w, routing.ErrCodeInvalidRequest, "cannot read body")
		return
	}
	var req map[string]any
	stream := false
	validate := func(b []byte) (string, *apiError) {
		if err := json.Unmarshal(b, &req); err != nil {
			return "", &apiError{Code: routing.ErrCodeInvalidRequest, Status: 400,
				Type: "invalid_request_error", Message: "invalid JSON body"}
		}
		slug, _ := req["model"].(string)
		if slug == "" {
			return "", &apiError{Code: routing.ErrCodeInvalidRequest, Status: 400,
				Type: "invalid_request_error", Message: "missing model"}
		}
		stream, _ = req["stream"].(bool)
		return slug, nil
	}

	lc, ok := h.begin(w, r, start, "/v1/chat/completions", body, validate, false)
	if !ok {
		return
	}
	defer lc.finish()

	// Inject `stream_options.include_usage` so a streamed reply carries the
	// usage block the bill is computed from (PRD §87).
	if stream {
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	upBody, _ := json.Marshal(req)

	lc.stream = stream
	upCtx := lc.upstreamContext(r, stream)
	resp, err := lc.dispatch(upCtx, upBody, r.Method, "", "/chat/completions")
	if err != nil || resp == nil {
		lc.fail(err)
		return
	}
	defer resp.Body.Close()
	lc.logTarget(resp.StatusCode)

	if stream {
		lc.streamSSE(w, resp.Body)
		return
	}

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	lc.serveBuffered(w, respBody, resp.Header)
}

// statusForKind maps a freebuff protocol failure to a taxonomy code.
func statusForKind(k freebuff.ErrorKind) string {
	switch k {
	case freebuff.KindAuthExpired:
		return routing.ErrCodeUpstreamError
	case freebuff.KindModelUnavailable:
		return routing.ErrCodeModelNotFound
	case freebuff.KindWaitingRoom:
		return routing.ErrCodeProviderUnavailable
	case freebuff.KindRateLimit:
		return routing.ErrCodeRateLimited
	case freebuff.KindBadRequest:
		return routing.ErrCodeInvalidRequest
	default:
		return routing.ErrCodeUpstreamError
	}
}

// retryableFreebuff maps a freebuff failure onto the spec §9 retry table.
func retryableFreebuff(k freebuff.ErrorKind) bool {
	switch k {
	case freebuff.KindAuthExpired, freebuff.KindWaitingRoom, freebuff.KindRateLimit, freebuff.KindNetwork:
		return true // another account or another target can fix it
	case freebuff.KindModelUnavailable, freebuff.KindBadRequest:
		return false
	}
	return false
}

// poolFor returns the rotation pool for one credential target: built on first
// use, rebuilt once its trust window has passed.
//
// The persist callback depends on where the secret lives: a credential ROW
// (spec §4) rewrites secret_enc; an unsplit legacy blob rewrites
// provider.credentials_enc. Both keep the same rotation/merge behaviour.
func (h *Handler) poolFor(key string, cred credentials, persist func(ctx context.Context, blob string) error, load func(ctx context.Context) (credentials, error)) *Pool {
	build := func() *Pool {
		return newPool(cred, h.refresher, h.crypt.Encrypt, persist, load)
	}
	if v, ok := h.pools.Load(key); ok {
		p := v.(*Pool)
		if !p.stale(time.Now(), poolReloadAfter) {
			return p
		}
		fresh := build()
		h.pools.Store(key, fresh)
		return fresh
	}
	actual, _ := h.pools.LoadOrStore(key, build())
	return actual.(*Pool)
}

// healthHealth is a tiny helper used by the health endpoint in main.go via the
// store's Ping; kept here so the file count stays flat.
