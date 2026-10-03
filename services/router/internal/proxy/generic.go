// The generic `/v1/*` passthrough: every model-addressed endpoint that is not
// the native chat path (completions, responses, embeddings, moderations, …).
//
// Endpoint fidelity (docs/specs/2026-09-25-endpoint-surface.md §6 P0):
//   - the REAL method is forwarded (r.Method, not POST);
//   - the query string survives (r.URL.RawQuery);
//   - the request Content-Type is passed through and non-JSON bodies are not
//     force-parsed;
//   - a JSON body carrying `stream: true` gets `stream_options.include_usage`
//     injected, so a streamed call is billed like the chat path;
//   - only model-addressed inference endpoints require a JSON body with
//     `model`.
package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// modelAddressed lists the model-addressed inference endpoints whose routing
// key is the body's `model` (endpoint-surface spec §6 P0 rule 1). Everything
// else on /v1/* either is native (models), stateful (files/batches/vector
// stores — honest 404, spec §6 P2 out of scope) or unimplemented.
var modelAddressed = map[string]bool{
	"/v1/chat/completions": true,
	"/v1/completions":      true,
	"/v1/embeddings":       true,
	"/v1/moderations":      true,
	"/v1/responses":        true,
}

// statefulPrefixes are the P2 stateful resources the router must OWN (files,
// batches, vector stores). They cannot be pass-through: the objects live here.
// Honest 404 until the schema and the ownership rules exist (spec §6 P2).
var statefulPrefixes = []string{"/v1/files", "/v1/batches", "/v1/vector_stores"}

// ServeGeneric proxies every other /v1/* endpoint to the upstream with the
// full lifecycle: auth, limits, budget, routing, fallback, billing, ledger.
//
// Unimplemented paths get a truthful 404 error body (schema spec §14 promise
// #5) — unless the `generic_passthrough` system setting is on, which restores
// the "forward anything to the upstream" escape hatch (endpoint-surface spec
// §8's open question, resolved deliberately: honesty is the default and the
// hatch is an operator decision). The switch is read per request, so flipping
// the setting needs no deploy.
//
// Order of gates matters (endpoint-surface spec §3.1): auth is evaluated BEFORE
// path support, so a bad key is 401 on every path and a valid key learns the
// truth — 404 for what does not exist. Validation therefore runs inside
// lifecycle.begin, after authentication.
func (h *Handler) ServeGeneric(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	path := r.URL.Path

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		h.writeErrCode(w, "INVALID_REQUEST", "cannot read body")
		return
	}

	stream := false
	passthrough := false
	validate := func(b []byte) (string, *apiError) {
		// Stateful resources (spec §6 P2): honest 404, never a forwarded lie.
		for _, p := range statefulPrefixes {
			if path == p || strings.HasPrefix(path, p+"/") {
				return "", &apiError{Code: "MODEL_NOT_FOUND", Status: 404,
					Type: "invalid_request_error",
					Message: fmt.Sprintf("%s is not implemented on this router: stateful resources are not routed", p)}
			}
		}
		if !modelAddressed[path] {
			// Unimplemented /v1/*: truthful 404 (spec §14 promise #5), unless the
			// operator raised the passthrough hatch.
			if !passthrough {
				return "", &apiError{Code: "MODEL_NOT_FOUND", Status: 404,
					Type: "invalid_request_error",
					Message: fmt.Sprintf("%s is not implemented on this router", path)}
			}
			// Escape hatch (endpoint-surface spec §8): forward the ad-hoc
			// endpoint. The upstream is still selected BY MODEL (spec §4 root
			// cause #5) — a body that names one routes exactly like a
			// model-addressed call (rerank-style endpoints keep working), and a
			// JSON `stream: true` body gets the same usage injection so the
			// streamed call bills (P0 rule 5). Without a model there is no
			// target to forward TO; picking one is the P2 provider-selection
			// strategy, deliberately out of scope — so say so honestly instead
			// of dropping the request upstream-less.
			var probe map[string]any
			if json.Unmarshal(b, &probe) == nil {
				if st, _ := probe["stream"].(bool); st {
					probe["stream_options"] = map[string]any{"include_usage": true}
					body, _ = json.Marshal(probe)
					stream = true
				}
				if s, _ := probe["model"].(string); s != "" {
					return s, nil
				}
			}
			return "", &apiError{Code: "INVALID_REQUEST", Status: 400,
				Type: "invalid_request_error",
				Message: fmt.Sprintf("%s cannot be forwarded: no model in the request body to select an upstream by", path)}
		}
		var req map[string]any
		if err := json.Unmarshal(b, &req); err != nil {
			return "", &apiError{Code: "INVALID_REQUEST", Status: 400,
				Type: "invalid_request_error", Message: "invalid JSON body"}
		}
		slug, _ := req["model"].(string)
		if slug == "" {
			return "", &apiError{Code: "INVALID_REQUEST", Status: 400,
				Type: "invalid_request_error", Message: "missing model"}
		}
		// Inject stream_options.include_usage on JSON stream requests, exactly
		// as the chat path does (endpoint-surface spec §6 P0 rule 5): a
		// streamed call through this path must be billed.
		if st, _ := req["stream"].(bool); st {
			req["stream_options"] = map[string]any{"include_usage": true}
			body, _ = json.Marshal(req)
			stream = true
		}
		return slug, nil
	}

	// Read the escape hatch before validation runs (it runs inside begin, after
	// auth). A lookup failure means the hatch is DOWN: honesty is the default.
	passthrough = h.store.GenericPassthrough(r.Context())

	lc, ok := h.begin(w, r, start, path, body, validate, false)
	if !ok {
		return
	}
	defer lc.finish()

	if !stream {
		if strings.Contains(r.Header.Get("Content-Type"), "event-stream") {
			stream = true
		} else if len(body) > 0 {
			var probe struct {
				Stream bool `json:"stream"`
			}
			if json.Unmarshal(body, &probe) == nil {
				stream = probe.Stream
			}
		}
	}
	lc.stream = stream

	upstreamPath := strings.TrimPrefix(path, "/v1")
	upCtx := lc.upstreamContext(r, stream)
	resp, err := lc.dispatch(upCtx, body, r.Method, r.URL.RawQuery, upstreamPath)
	if err != nil || resp == nil {
		lc.fail(err)
		return
	}
	defer resp.Body.Close()
	lc.logTarget(resp.StatusCode)

	// A streaming upstream must not be buffered. No timer is armed on this
	// branch: a stream lives until the client disconnects.
	if strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		lc.streamSSE(w, resp.Body)
		return
	}

	// Non-streaming: bound the body read with a timer that CLOSES the body when
	// it fires (closing is the only lever that stops a stalled read without
	// cancelling a context the response depends on).
	bodyTimer := time.AfterFunc(genericTimeout, func() {
		_ = resp.Body.Close()
	})
	defer bodyTimer.Stop()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		lc.fail(fmt.Errorf("read upstream: %w", err))
		return
	}
	lc.serveBuffered(w, respBody, resp.Header)
}
