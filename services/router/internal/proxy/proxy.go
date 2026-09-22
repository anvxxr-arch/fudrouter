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

	// pools caches one rotation Pool per provider. The pool is the in-memory
	// source of truth for account state once built, because it is also the
	// writer of the persisted blob.
	pools sync.Map // providerID -> *Pool
}

// New builds the hot-path handler. A nil refresher disables token refresh,
// which is only correct for providers using a static api_key.
func New(st *store.Store, cr *crypt.Crypt, client *http.Client, refresher TokenRefresher) *Handler {
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return &Handler{
		store:     st,
		crypt:     cr,
		client:    client,
		refresher: refresher,
		freebuff:  freebuff.New(os.Getenv("FREEBUFF_BASE_URL")),
	}
}

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

// poolFor returns the rotation pool for a provider, building it on first use.
func (h *Handler) poolFor(m *store.ModelRow, cred credentials) *Pool {
	if v, ok := h.pools.Load(m.ProviderID); ok {
		return v.(*Pool)
	}
	p := newPool(cred, h.refresher,
		h.crypt.Encrypt,
		func(ctx context.Context, blob string) error {
			return h.store.UpdateProviderCredentials(ctx, m.ProviderID, blob)
		},
	)
	actual, _ := h.pools.LoadOrStore(m.ProviderID, p)
	return actual.(*Pool)
}

// headers a stored default_header may never override.
var reservedHeaders = map[string]bool{
	"authorization": true,
	"content-type":  true,
	"host":          true,
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
			upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
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

// ServeModels emits the [OI] /v1/models list shape.
func (h *Handler) ServeGeneric(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	keyRow, err := h.authenticate(r)
	if err != nil {
		h.writeErr(w, http.StatusUnauthorized, err.Error())
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

	var picked Picked
	var lastErr error
	for i := 0; i < 3; i++ {
		p, err := pool.Pick(r.Context())
		if err != nil {
			lastErr = err
			continue
		}
		picked = p
		break
	}
	if picked.Token == "" {
		log.Printf("[proxy] no usable credential for provider %s: %v", m.ProviderID, lastErr)
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "no usable credential")
		h.writeErr(w, http.StatusBadGateway, "no usable upstream credential")
		return
	}

	upURL := strings.TrimRight(m.BaseURL, "/") + strings.TrimPrefix(r.URL.Path, "/v1")
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

	resp, err := h.client.Do(upReq)
	if err != nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", err.Error())
		h.writeErr(w, http.StatusBadGateway, "upstream request failed")
		return
	}
	defer resp.Body.Close()

	log.Printf("[proxy] provider=%s path=%s account=%s status=%d",
		m.ProviderID, r.URL.Path, picked.Email, resp.StatusCode)

	// Copy upstream headers
	for k, v := range resp.Header {
		for _, vv := range v {
			w.Header().Add(k, vv)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
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
