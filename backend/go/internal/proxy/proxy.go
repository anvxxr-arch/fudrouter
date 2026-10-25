// Package proxy serves the [OI]-compatible hot path (PRD §85 request
// lifecycle).
//
// One lifecycle for every endpoint (§85): authenticate → limits → budget →
// resolve model → route → attempt(s) → record → charge. The two public entry
// points (ServeCompletions for chat, ServeGeneric for the rest) differ only in
// body handling; everything else is shared machinery in lifecycle.go.
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

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/limits"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

type Handler struct {
	store     *store.Store
	crypt     *crypt.Crypt
	client    *http.Client
	refresher TokenRefresher

	// limiter enforces the spec §7 limit chain (Valkey fast path, S0 in-process
	// fallback, fail-open on a cache outage).
	limiter *limits.Limiter

	// vk is the cache/counter layer (spec §12): budget counters, circuit state.
	vk vk.Client

	// breaker holds routing circuit state (spec §9); config comes from the
	// circuit_breaker table and is refreshed with the routing policy.
	breaker *routing.CircuitBreaker

	// healthInMem is the process-local fallback for probe results when the
	// Valkey snapshot is unreadable — see health.go. Fallback, not primary.
	healthInMem sync.Map

	// healthViewCached is the render-path's in-process snapshot of the Valkey
	// health map: the render guarantee is ONE Valkey read per window
	// (models_render_cache_test), so the health read must not join the
	// per-render budget — it refreshes on its own short TTL instead.
	healthViewMu     sync.Mutex
	healthViewCached map[string]HealthEntry
	healthViewExp    time.Time

	// pools caches one rotation Pool per credential target. The pool is the
	// in-memory source of truth for account state once built, because it is
	// also the writer of the persisted secret.
	pools sync.Map // target key -> *Pool

	// showCostMeta gates the cost metadata response headers (PRD §90). Default
	// off: pricing is not disclosed per-request unless explicitly enabled.
	showCostMeta bool

	// renderCache holds the fully rendered GET /v1/models body. Measured on the
	// deployed box the endpoint was CPU-bound at ~3.08 ms/request (~1000-1140
	// req/s on 4 cores) while /health on the same listener did ~8300 req/s:
	// json.Unmarshal of the cached catalogue (884 µs) + modelObject maps (251
	// µs) + json.Encoder.Encode of the 64.5 KB document (1.38 ms) per request.
	// Caching the rendered bytes drops the hot path to one w.Write. dev is
	// stored beside the body because devProviders() changes the model list
	// (catalog_cache.go: catalogueKey's dev= component) — a body rendered under
	// one flag must never be served under the other. buildMu serializes the
	// render itself so N concurrent requests landing on an expired entry
	// produce one render, not N (the thundering herd is once per 45 s, but
	// without this it would spike CPU on the first request after expiry); the
	// cache mutex is never held across cachedModels, which does DB I/O.
	renderMu   sync.Mutex
	render     []byte
	renderDev  bool
	renderExp  time.Time
	renderOnce sync.Mutex
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
			// NO environment proxy. `http.ProxyFromEnvironment` would make Go
			// dial the PROXY address, so the dial guard would inspect the proxy
			// and never the provider — the guard stops being a guard on base_url
			// at all, and CONNECT-tunnelled traffic hands the rotated provider
			// bearer tokens to a third party. The other upstream clients
			// (pool.go) already omit it, so this made the chat path the only
			// one whose target was unpinned.
			//
			// A proxy deployment, if one is ever wanted, must instead be an
			// explicit, reviewed setting that keeps the real target verifiable.
			DialContext:       dialer.DialContext,
			ForceAttemptHTTP2: true,
			MaxIdleConns:      100,
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
	// usage block the bill is computed from (PRD §87). Merge into any
	// client-supplied stream_options instead of replacing it: the contract
	// forwards the body essentially verbatim (inference.yaml), and
	// include_usage is forced true — billing depends on it.
	if stream {
		so, _ := req["stream_options"].(map[string]any)
		if so == nil {
			so = map[string]any{}
		}
		so["include_usage"] = true
		req["stream_options"] = so
	}
	upBody, _ := json.Marshal(req)

	lc.stream = stream
	// Compress oversized tool results before dispatch (compress.go). The
	// saving is estimated and recorded on the row; the bill still comes from
	// the provider's usage block. A caller can opt out for one request with
	// X-Fudrouter-Token-Saver: off, and any failure leaves the body untouched.
	if !tokenSaverDisabled(r.Header.Get(tokenSaverHeader)) {
		if compressed, saved := compressToolResults(upBody); saved > 0 {
			upBody = compressed
			lc.tokensSaved = saved
		}
	}
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

	respBody, err := lc.readUpstreamBody(resp)
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	lc.serveBuffered(w, respBody, resp.Header)
}

// poolBuildHook is nil in production. export_test.go sets it so a test can
// hold every poolFor racer inside the rebuild window simultaneously — the H2
// double-persist race is only observable when two racers are between the
// stale check and the CAS at the same time.
var poolBuildHook func()

// poolFor returns the rotation pool for one credential target: built on first
// use, rebuilt once its trust window has passed.
//
// The persist callback depends on where the secret lives: a credential ROW
// (spec §4) rewrites secret_enc; an unsplit legacy blob rewrites
// provider.credentials_enc. Both keep the same rotation/merge behaviour.
func (h *Handler) poolFor(key string, cred credentials, persist func(ctx context.Context, blob string) error, load func(ctx context.Context) (credentials, error)) *Pool {
	build := func() *Pool {
		// poolBuildHook is nil in production; export_test.go sets it to hold
		// every racer inside the rebuild window simultaneously (the H2 race
		// is only observable when two racers are between the stale check and
		// the CAS at the same time). Same pattern as SetGenericTimeoutForTest.
		if poolBuildHook != nil {
			poolBuildHook()
		}
		return newPool(cred, h.refresher, h.crypt.Encrypt, persist, load)
	}
	if v, ok := h.pools.Load(key); ok {
		p := v.(*Pool)
		if !p.stale(time.Now(), poolReloadAfter) {
			return p
		}
		// H2: the rebuild must be a compare-and-swap. A bare Store let two
		// concurrent rebuilds both persist their rotated refresh tokens; the
		// loser's token dies upstream and the account breaks on its next
		// expiry. CompareAndSwap installs the fresh pool ONLY while the
		// stale one is still the stored value: the first racer swaps it in,
		// every later racer's CAS fails and it re-Loads — picking up the
		// winner's pool and discarding its own candidate, so exactly one
		// rebuild persists its tokens. (Delete-then-LoadOrStore was tried
		// first and is wrong: a racer that loaded the stale pool, then
		// deleted AFTER the winner installed the fresh one, would delete the
		// fresh pool and install its own — two rebuilds again.)
		fresh := build()
		if h.pools.CompareAndSwap(key, v, fresh) {
			return fresh
		}
		// Lost the race: the stored pool is the winner's (or a newer
		// rebuild's). Re-load and use it — never the discarded candidate.
		if w, ok := h.pools.Load(key); ok {
			return w.(*Pool)
		}
		// The winner's entry vanished between CAS and Load (nothing deletes
		// but this branch, so unreachable — stay honest anyway): fall through
		// to the first-use LoadOrStore.
	}
	actual, _ := h.pools.LoadOrStore(key, build())
	return actual.(*Pool)
}
