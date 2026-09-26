// Package proxy serves the [OI]-compatible hot path.
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/cost"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/freebuff"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/keys"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

type Handler struct {
	store     *store.Store
	crypt     *crypt.Crypt
	client    *http.Client
	refresher TokenRefresher

	// freebuff drives the native Codebuff/Freebuff protocol for providers whose
	// credential blob declares protocol="freebuff".
	freebuff *freebuff.Manager

	// limits enforces api_key.limits (rpm + monthly cost cap), which the admin
	// console has always written but the data plane never read.
	limits *limiter

	// pools caches one rotation Pool per provider. The pool is the in-memory
	// source of truth for account state once built, because it is also the
	// writer of the persisted blob.
	pools sync.Map // providerID -> *Pool
}

// New builds the hot-path handler. A nil refresher disables token refresh,
// which is only correct for providers using a static api_key.
func New(st *store.Store, cr *crypt.Crypt, client *http.Client, refresher TokenRefresher) *Handler {
	if client == nil {
		client = newUpstreamClient()
	}
	return &Handler{
		store:     st,
		crypt:     cr,
		client:    client,
		refresher: refresher,
		freebuff:  freebuff.New(os.Getenv("FREEBUFF_BASE_URL")),
		limits:    newLimiter(),
	}
}

// newUpstreamClient builds the client used for plain [OI] passthrough.
//
// It deliberately carries NO overall Timeout: http.Client.Timeout bounds the
// whole exchange INCLUDING the response body, so a 120s value cut any streaming
// completion longer than two minutes mid-answer (the freebuff client uses 15
// minutes for the same reason). Liveness is bounded per phase instead
// (dial/TLS/response-header) and per request by the caller's context.
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
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 120 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

// maxTokensPerRequest bounds the token counts the router will bill from an
// upstream's reported usage. The router does not count tokens itself — it
// trusts the upstream's `usage` block — so a hostile or buggy upstream can
// report a negative count, which makes cost negative and *lowers* the month's
// accumulated spend, letting a key walk past its monthly_cost_micro cap. The
// ceiling is a sanity bound (a real single request never approaches it) that
// also keeps the cost multiply well inside big.Int's comfort zone.
const maxTokensPerRequest = 100_000_000

// clampTokens forces a reported token count into [0, maxTokensPerRequest].
func clampTokens(n int64) int64 {
	if n < 0 {
		return 0
	}
	if n > maxTokensPerRequest {
		return maxTokensPerRequest
	}
	return n
}

// nonStreamTimeout bounds a non-streaming completion end to end. A stream has no
// such bound: it is governed by the client's own connection.
const nonStreamTimeout = 120 * time.Second

// statusForKind maps a freebuff protocol failure to the HTTP status reported
// when the router cannot fail over to another account.
func statusForKind(k freebuff.ErrorKind) int {
	switch k {
	case freebuff.KindAuthExpired:
		return http.StatusUnauthorized
	case freebuff.KindModelUnavailable:
		return http.StatusNotFound
	default:
		return http.StatusBadGateway
	}
}

// poolReloadAfter bounds how long a built pool is trusted. The blob can be
// rewritten from outside this process — an import, a maintenance rotation — and
// a pool that never reloads keeps serving tokens that were rotated away,
// refusing every request for that provider until someone restarts it. The
// reload is cheap: the caller already decrypted the current blob to get here.
//
// A var, not a const, so a test can exercise the reload without sleeping.
var poolReloadAfter = time.Minute

// poolFor returns the rotation pool for a provider: built on first use, rebuilt
// once its trust window has passed.
func (h *Handler) poolFor(m *store.ModelRow, cred credentials) *Pool {
	build := func() *Pool {
		return newPool(cred, h.refresher,
			h.crypt.Encrypt,
			func(ctx context.Context, blob string) error {
				return h.store.UpdateProviderCredentials(ctx, m.ProviderID, blob)
			},
			func(ctx context.Context) (credentials, error) {
				enc, err := h.store.ProviderCredentials(ctx, m.ProviderID)
				if err != nil {
					return credentials{}, err
				}
				plain, err := h.crypt.Decrypt(enc)
				if err != nil {
					return credentials{}, err
				}
				var cur credentials
				if err := json.Unmarshal([]byte(plain), &cur); err != nil {
					return credentials{}, err
				}
				return cur, nil
			},
		)
	}
	if v, ok := h.pools.Load(m.ProviderID); ok {
		p := v.(*Pool)
		if !p.stale(time.Now(), poolReloadAfter) {
			return p
		}
		fresh := build()
		h.pools.Store(m.ProviderID, fresh)
		return fresh
	}
	actual, _ := h.pools.LoadOrStore(m.ProviderID, build())
	return actual.(*Pool)
}

// headers a stored default_header may never override.
var reservedHeaders = map[string]bool{
	"authorization": true,
	"content-type":  true,
	"host":          true,
}

// responseHeadersForwarded is an ALLOWLIST of upstream response headers copied to
// the client. A blacklist leaks every new header an upstream or its CDN invents;
// the generic passthrough used to forward all of them, so clients received the
// upstream's Set-Cookie (__cf_bm, Domain=openrouter.ai), Via, Server, Cf-Ray,
// X-Unikey-* and its Access-Control-Allow-Origin: *. Content-Length is omitted so
// Go recomputes it from the body actually written.
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

func (h *Handler) writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
}

// authenticate parses + validates the Bearer key against the api_key table.
func (h *Handler) authenticate(r *http.Request) (*store.APIKeyRow, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	k, ok := keys.Parse(strings.TrimPrefix(auth, "Bearer "))
	if !ok {
		return nil, errors.New("malformed api key")
	}
	row, err := h.store.LookupAPIKey(r.Context(), k.Prefix)
	if err != nil {
		return nil, errors.New("invalid api key")
	}
	if !keys.Equal(row.KeyHash, keys.Hash(k.Secret)) {
		return nil, errors.New("invalid api key")
	}
	if row.RevokedAt != nil {
		return nil, errors.New("api key revoked")
	}
	return row, nil
}

func (h *Handler) ServeCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	keyRow, err := h.authenticate(r)
	if err != nil {
		h.writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if status, msg := h.checkLimits(r.Context(), keyRow); status != 0 {
		log.Printf("[proxy] key=%s rejected by limits: %d %s", keyRow.ID, status, msg)
		h.writeErr(w, status, msg)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		h.writeErr(w, http.StatusBadRequest, "cannot read body")
		return
	}
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	slug, _ := req["model"].(string)
	if slug == "" {
		h.writeErr(w, http.StatusBadRequest, "missing model")
		return
	}
	stream, _ := req["stream"].(bool)

	m, err := h.store.ModelWithProvider(r.Context(), slug)
	if err != nil {
		h.writeErr(w, http.StatusNotFound, "unknown model: "+slug)
		return
	}

	credJSON, err := h.crypt.Decrypt(m.CredEnc)
	if err != nil {
		// Never include the ciphertext or plaintext in errors (Review Focus 4).
		log.Printf("[proxy] credential decrypt failed for provider %s", m.ProviderID)
		h.writeErr(w, http.StatusInternalServerError, "provider credentials unavailable")
		return
	}
	var cred credentials
	if err := json.Unmarshal([]byte(credJSON), &cred); err != nil {
		h.writeErr(w, http.StatusInternalServerError, "provider credentials malformed")
		return
	}
	if cred.APIKey == "" && len(cred.Accounts) == 0 {
		h.writeErr(w, http.StatusInternalServerError, "provider credentials malformed")
		return
	}

	if stream {
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	upBody, _ := json.Marshal(req)

	// One attempt per account, so a rejected credential fails over instead of
	// failing the request. A single static-key provider simply gets one try.
	attempts := 1
	if n := len(cred.Accounts); n > 1 {
		attempts = n
		if attempts > 3 {
			attempts = 3
		}
	}
	pool := h.poolFor(m, cred)

	// A non-streaming completion is bounded end to end; a stream is not, because
	// http.Client.Timeout would sever it mid-answer (the old 120s client did
	// exactly that). A stream lives until the client disconnects (r.Context()).
	upCtx := r.Context()
	if !stream {
		var cancel context.CancelFunc
		upCtx, cancel = context.WithTimeout(r.Context(), nonStreamTimeout)
		defer cancel()
	}

	var resp *http.Response
	var lastStatus int
	var servedBy string
	usedAttempts := 0
	for attempt := 0; attempt < attempts; attempt++ {
		picked, err := pool.Pick(r.Context())
		if err != nil {
			log.Printf("[proxy] no usable credential for provider %s: %v", m.ProviderID, err)
			h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "no usable credential")
			h.writeErr(w, http.StatusBadGateway, "no usable upstream credential")
			return
		}

		if cred.Protocol == ProtocolFreebuff {
			// Native Codebuff/Freebuff protocol. The upstream is NOT [OI]: a chat
			// needs a live session, a root agent run, and codebuff_metadata
			// injection, so the plain passthrough below cannot be used.
			resp, err = h.freebuff.Chat(r.Context(), m.BaseURL, picked.Token, m.Slug, upBody)
			if err != nil {
				var pe *freebuff.Error
				if errors.As(err, &pe) {
					switch pe.Kind {
					case freebuff.KindAuthExpired, freebuff.KindModelUnavailable:
						// Bad credential or bad model: fail over to another
						// account within the same request.
						pool.MarkFailed(picked.Token)
						lastStatus = statusForKind(pe.Kind)
						continue
					case freebuff.KindWaitingRoom, freebuff.KindRateLimit:
						// Upstream queue/limit: surface a Retry-After instead of
						// hammering it.
						if pe.RetryAfter > 0 {
							w.Header().Set("Retry-After", strconv.Itoa(pe.RetryAfter))
						}
						h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error", pe.Msg)
						h.writeErr(w, http.StatusServiceUnavailable, pe.Msg)
						return
					}
				}
				h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", err.Error())
				h.writeErr(w, http.StatusBadGateway, err.Error())
				return
			}
		} else {
			upReq, err := http.NewRequestWithContext(upCtx, http.MethodPost,
				strings.TrimRight(m.BaseURL, "/")+"/chat/completions", bytes.NewReader(upBody))
			if err != nil {
				h.writeErr(w, http.StatusInternalServerError, "upstream request build failed")
				return
			}
			upReq.Header.Set("Content-Type", "application/json")
			upReq.Header.Set("Authorization", "Bearer "+picked.Token)
			for k, v := range cred.DefaultHeaders {
				if reservedHeaders[strings.ToLower(k)] {
					continue
				}
				upReq.Header.Set(k, v)
			}

			resp, err = h.client.Do(upReq)
			if err != nil {
				h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", err.Error())
				h.writeErr(w, http.StatusBadGateway, "upstream request failed")
				return
			}
		}
		lastStatus = resp.StatusCode

		// The credential was rejected: drop that account and try another.
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
			resp = nil
			pool.MarkFailed(picked.Token)
			continue
		}
		servedBy = picked.Email
		usedAttempts = attempt + 1
		break
	}

	if resp == nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error",
			fmt.Sprintf("upstream %d on every account", lastStatus))
		h.writeErr(w, http.StatusBadGateway, "upstream rejected every pooled credential")
		return
	}
	defer resp.Body.Close()

	// Which account served a request is not otherwise observable: the pool is
	// in-memory and request_log has no account column. Without this line a pool
	// that silently collapses onto one account looks identical to a healthy one.
	log.Printf("[proxy] provider=%s model=%s account=%s attempt=%d status=%d",
		m.ProviderID, m.Slug, servedBy, usedAttempts, resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error",
			fmt.Sprintf("upstream %d", resp.StatusCode))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(errBody)
		return
	}

	_ = h.store.TouchAPIKey(r.Context(), keyRow.ID)

	if stream {
		h.streamSSE(w, resp.Body, keyRow, m, start)
		return
	}

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "read upstream: "+err.Error())
		h.writeErr(w, http.StatusBadGateway, "upstream read failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBody)

	var parsed struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(respBody, &parsed)
	tin, tout := int64(0), int64(0)
	if parsed.Usage != nil {
		tin, tout = parsed.Usage.PromptTokens, parsed.Usage.CompletionTokens
	}
	h.logRequest(r.Context(), keyRow, m, tin, tout, start, "success", "")
}

// streamSSE copies the upstream SSE to the client line-group by line-group,
// capturing the usage object from the final data chunk.
func (h *Handler) streamSSE(w http.ResponseWriter, body io.Reader, keyRow *store.APIKeyRow, m *store.ModelRow, start time.Time) {
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	var tokensIn, tokensOut int64
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		_, _ = fmt.Fprintln(w, line)
		if fl != nil {
			fl.Flush()
		}
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			if payload != "[DONE]" {
				var chunk struct {
					Usage *struct {
						PromptTokens     int64 `json:"prompt_tokens"`
						CompletionTokens int64 `json:"completion_tokens"`
					} `json:"usage"`
				}
				if err := json.Unmarshal([]byte(payload), &chunk); err == nil && chunk.Usage != nil {
					tokensIn = chunk.Usage.PromptTokens
					tokensOut = chunk.Usage.CompletionTokens
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		h.logRequest(context.Background(), keyRow, m, tokensIn, tokensOut, start, "error", "stream: "+err.Error())
		return
	}
	h.logRequest(context.Background(), keyRow, m, tokensIn, tokensOut, start, "success", "")
}

func (h *Handler) logRequest(ctx context.Context, keyRow *store.APIKeyRow, m *store.ModelRow, tin, tout int64, start time.Time, status, errText string) {
	// Detach from the request context before writing the usage row. A client that
	// disconnects mid-response cancels r.Context(), and the non-stream path
	// passed exactly that context here — so a disconnect silently lost the row
	// (seen live: "request_log insert failed: context canceled"). The ledger must
	// survive the client. Bounded so a wedged DB cannot leak a goroutine.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	// Clamp at the single funnel every path bills through, rather than at each
	// parse site: the token counts come from the upstream's own `usage` block,
	// which is untrusted. A negative count would make cost negative and lower
	// the month's total, walking a key past its monthly_cost_micro cap.
	tin, tout = clampTokens(tin), clampTokens(tout)

	c := cost.Compute(tin, tout, cost.Price(m.InputPrice), cost.Price(m.OutputPrice))
	if err := h.store.InsertRequestLog(ctx, &store.RequestLog{
		UserID:     keyRow.UserID,
		APIKeyID:   keyRow.ID,
		ModelID:    m.ModelID,
		ProviderID: m.ProviderID,
		TokensIn:   tin,
		TokensOut:  tout,
		Cost:       c,
		Currency:   m.Currency,
		LatencyMs:  time.Since(start).Milliseconds(),
		Status:     status,
		Error:      errText,
	}); err != nil {
		log.Printf("[proxy] request_log insert failed: %v", err)
	}
}

// ServeGeneric proxies every other /v1/* endpoint (embeddings, rerank, …) to the
// upstream. Unlike the old passthrough it enforces key limits, fails over across
// pooled accounts on 401/403, relays only allowlisted response headers, and
// writes a request_log row — so the call is billed and visible to usage/limits.
func (h *Handler) ServeGeneric(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	keyRow, err := h.authenticate(r)
	if err != nil {
		h.writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	if status, msg := h.checkLimits(r.Context(), keyRow); status != 0 {
		log.Printf("[proxy] key=%s rejected by limits: %d %s", keyRow.ID, status, msg)
		h.writeErr(w, status, msg)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		h.writeErr(w, http.StatusBadRequest, "cannot read body")
		return
	}
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	slug, _ := req["model"].(string)
	if slug == "" {
		h.writeErr(w, http.StatusBadRequest, "missing model")
		return
	}

	m, err := h.store.ModelWithProvider(r.Context(), slug)
	if err != nil {
		h.writeErr(w, http.StatusNotFound, "unknown model: "+slug)
		return
	}

	credJSON, err := h.crypt.Decrypt(m.CredEnc)
	if err != nil {
		log.Printf("[proxy] credential decrypt failed for provider %s", m.ProviderID)
		h.writeErr(w, http.StatusInternalServerError, "provider credentials unavailable")
		return
	}
	var cred credentials
	if err := json.Unmarshal([]byte(credJSON), &cred); err != nil {
		h.writeErr(w, http.StatusInternalServerError, "provider credentials malformed")
		return
	}
	if cred.APIKey == "" && len(cred.Accounts) == 0 {
		h.writeErr(w, http.StatusInternalServerError, "provider credentials malformed")
		return
	}

	pool := h.poolFor(m, cred)
	upURL := strings.TrimRight(m.BaseURL, "/") + strings.TrimPrefix(r.URL.Path, "/v1")

	// Fail over across pooled accounts on a rejected credential, exactly as the
	// chat path does. The old single-Pick version handed a dead token straight to
	// the client even when healthy accounts remained.
	attempts := 1
	if n := len(cred.Accounts); n > 1 {
		attempts = n
		if attempts > 3 {
			attempts = 3
		}
	}

	var resp *http.Response
	var lastStatus int
	var servedBy string
	usedAttempts := 0
	for attempt := 0; attempt < attempts; attempt++ {
		picked, err := pool.Pick(r.Context())
		if err != nil {
			log.Printf("[proxy] no usable credential for provider %s: %v", m.ProviderID, err)
			h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "no usable credential")
			h.writeErr(w, http.StatusBadGateway, "no usable upstream credential")
			return
		}

		upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upURL, bytes.NewReader(body))
		if err != nil {
			h.writeErr(w, http.StatusInternalServerError, "upstream request build failed")
			return
		}
		upReq.Header.Set("Content-Type", "application/json")
		upReq.Header.Set("Authorization", "Bearer "+picked.Token)
		for k, v := range cred.DefaultHeaders {
			if reservedHeaders[strings.ToLower(k)] {
				continue
			}
			upReq.Header.Set(k, v)
		}

		resp, err = h.client.Do(upReq)
		if err != nil {
			h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", err.Error())
			h.writeErr(w, http.StatusBadGateway, "upstream request failed")
			return
		}
		lastStatus = resp.StatusCode

		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
			resp = nil
			pool.MarkFailed(picked.Token)
			continue
		}
		servedBy = picked.Email
		usedAttempts = attempt + 1
		break
	}

	if resp == nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error",
			fmt.Sprintf("upstream %d on every account", lastStatus))
		h.writeErr(w, http.StatusBadGateway, "upstream rejected every pooled credential")
		return
	}
	defer resp.Body.Close()

	log.Printf("[proxy] provider=%s path=%s account=%s attempt=%d status=%d",
		m.ProviderID, r.URL.Path, servedBy, usedAttempts, resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error",
			fmt.Sprintf("upstream %d", resp.StatusCode))
		copyUpstreamHeaders(w, resp.Header)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(errBody)
		return
	}

	// Streaming upstreams (rare on this path) must not be buffered.
	if strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		_ = h.store.TouchAPIKey(r.Context(), keyRow.ID)
		h.streamSSE(w, resp.Body, keyRow, m, start)
		return
	}

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "read upstream: "+err.Error())
		h.writeErr(w, http.StatusBadGateway, "upstream read failed")
		return
	}
	_ = h.store.TouchAPIKey(r.Context(), keyRow.ID)

	// Only allowlisted headers are relayed; Content-Length is left to Go.
	copyUpstreamHeaders(w, resp.Header)
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBody)

	tin, tout := usageFromBody(respBody)
	h.logRequest(r.Context(), keyRow, m, tin, tout, start, "success", "")
}

// usageFromBody pulls prompt/completion tokens out of a JSON response, tolerating
// both the [OI] `usage` shape and the `input_tokens`/`output_tokens` variant.
func usageFromBody(b []byte) (int64, int64) {
	var parsed struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			InputTokens      int64 `json:"input_tokens"`
			OutputTokens     int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &parsed); err != nil || parsed.Usage == nil {
		return 0, 0
	}
	tin, tout := parsed.Usage.PromptTokens, parsed.Usage.CompletionTokens
	if tin == 0 {
		tin = parsed.Usage.InputTokens
	}
	if tout == 0 {
		tout = parsed.Usage.OutputTokens
	}
	return tin, tout
}

func (h *Handler) ServeModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.store.ActiveModels(r.Context())
	if err != nil {
		h.writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		data = append(data, map[string]any{"id": m.Slug, "object": "model", "owned_by": "fudrouter"})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data":   data,
	})
}
