// HTTP transport against the Codebuff upstream.
//
// The client carries the same SSRF dial guard as the [OI] client: `base_url`
// comes from a provider row, which the control plane validates only literally and
// which is explicitly not a security boundary (guard.go). Without this hook a
// provider whose blob declares protocol="freebuff" could reach the internal
// network — including the cloud metadata address — and, with redirects followed
// by default, a public upstream could 302 onto it.
//
// Split out of client.go so the guard's wiring, the timeout budget, and the
// request bodies are each readable without the protocol constants above them.
package freebuff

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/netguard"
)

// client is the raw HTTP layer against the Codebuff upstream.
type client struct {
	baseURL string
	http    *http.Client
}

func newClient(baseURL string) *client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "https://codebuff.com" {
		baseURL = DefaultBaseURL
	}
	return &client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 15 * time.Minute, // streaming: long docs must not be cut
			// base_url comes from the provider row, which the control plane
			// validates only literally and which is not a security boundary. The
			// dial guard is what makes it safe to trust: it refuses any target
			// that resolves into loopback/RFC1918/link-local/CGNAT, and because
			// every redirect dials through the same transport, a hop onto an
			// internal address is refused too. Until now this client had no
			// guard at all while the [OI] client had one, so a provider whose
			// blob declared protocol="freebuff" was an unguarded path into the
			// internal network. The rule lives in internal/netguard so both
			// clients enforce exactly one boundary.
			CheckRedirect: netguard.RedirectPolicy,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout:   15 * time.Second,
					KeepAlive: 30 * time.Second,
					Control:   netguard.DialControl(netguard.AllowPrivate()),
				}).DialContext,
				ForceAttemptHTTP2:     true,
				MaxIdleConns:          100,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   15 * time.Second,
				ResponseHeaderTimeout: 120 * time.Second,
			},
		},
	}
}

func (c *client) authHeaders(token string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	h.Set("Content-Type", "application/json")
	h.Set("User-Agent", codebuffUA)
	return h
}

// createSession POSTs `{}` with the model header; the upstream answers
// active / queued.
func (c *client) createSession(ctx context.Context, token, model, instanceID string) (sessionResponse, error) {
	h := c.authHeaders(token)
	h.Set(headerModel, model)
	h.Set(headerMulti, instanceHeader)
	if instanceID != "" {
		h.Set(headerInstance, instanceID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathSession, strings.NewReader("{}"))
	if err != nil {
		return sessionResponse{}, err
	}
	req.Header = h
	return c.doJSON(req)
}

// startRun opens a root agent run under the active session. ancestorRunIds is
// an explicit empty array — `null` is rejected by the upstream schema.
func (c *client) startRun(ctx context.Context, token, agentID string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"action":         "START",
		"agentId":        agentID,
		"ancestorRunIds": []string{},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathAgentRuns, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header = c.authHeaders(token)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 300 {
		var out startRunResponse
		if err := json.Unmarshal(raw, &out); err != nil {
			return "", fmt.Errorf("freebuff: start run unparseable: %w", err)
		}
		if id := out.id(); id != "" {
			return id, nil
		}
		return "", fmt.Errorf("freebuff: start run response missing runId")
	}
	// A 4xx here is not fatal for the request as a whole: the chat can still be
	// attempted, but without a run it will fail upstream. Surface it.
	return "", &httpError{Status: resp.StatusCode, Body: string(raw)}
}

// finishRun closes the run. "not found"/"not running" is success — the run may
// already have been reaped upstream.
func (c *client) finishRun(ctx context.Context, token, runID string, steps int64) error {
	body, _ := json.Marshal(map[string]any{
		"action":        "FINISH",
		"runId":         runID,
		"status":        "completed",
		"totalSteps":    steps,
		"directCredits": 0,
		"totalCredits":  0,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathAgentRuns, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header = c.authHeaders(token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 300 {
		return nil
	}
	text := strings.ToLower(string(raw))
	if strings.Contains(text, "not found") || strings.Contains(text, "not running") {
		return nil
	}
	return &httpError{Status: resp.StatusCode, Body: string(raw)}
}

// chat POSTs the [OI]-shaped body with codebuff_metadata injected, and returns
// the raw upstream response for the caller to stream or relay.
func (c *client) chat(ctx context.Context, token string, body []byte, runID, instanceID string) (*http.Response, error) {
	patched, err := injectMetadata(body, runID, instanceID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+pathChat, bytes.NewReader(patched))
	if err != nil {
		return nil, err
	}
	req.Header = c.authHeaders(token)
	return c.http.Do(req)
}

func (c *client) doJSON(req *http.Request) (sessionResponse, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return sessionResponse{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if resp.StatusCode >= 300 {
		return sessionResponse{}, &httpError{Status: resp.StatusCode, Body: string(raw)}
	}
	var out sessionResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return sessionResponse{}, fmt.Errorf("freebuff: unparseable session body: %w", err)
	}
	return out, nil
}
