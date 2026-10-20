package freebuff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// sessionGrace is how long before expiry a session is considered stale and
// rebuilt. Mirrors the upstream 5s guard.
const sessionGrace = 5 * time.Second

// maxSessionAttempts bounds the create/poll loop so a wedged upstream cannot
// spin a request forever.
const maxSessionAttempts = 3

// Error is a classified protocol failure. Kind tells the caller whether to
// fail over (auth), back off (rate limit / waiting room), or give up.
type Error struct {
	Kind       ErrorKind
	Msg        string
	RetryAfter int // seconds; 0 when no hint
}

func (e *Error) Error() string { return e.Msg }

// Manager owns per-(base URL, token) session state and orchestrates a chat
// through the full freebuff protocol. One Manager serves every freebuff
// provider; the upstream host comes from the provider row's base_url.
type Manager struct {
	defaultBase string

	clients  sync.Map // baseURL -> *client
	sessions sync.Map // baseURL|sha256(token) -> *sessionState

	// prevToken tracks the last token seen per base URL so a rotated bearer
	// token can evict the session entry keyed by its predecessor (H1).
	prevToken sync.Map // baseURL -> token
}

// New builds a Manager. defaultBase is used when a caller passes an empty base
// URL; an empty defaultBase falls back to DefaultBaseURL.
func New(defaultBase string) *Manager {
	if strings.TrimSpace(defaultBase) == "" {
		defaultBase = DefaultBaseURL
	}
	return &Manager{defaultBase: defaultBase}
}

func (m *Manager) clientFor(baseURL string) *client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = m.defaultBase
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if v, ok := m.clients.Load(baseURL); ok {
		return v.(*client)
	}
	c := newClient(baseURL)
	actual, _ := m.clients.LoadOrStore(baseURL, c)
	return actual.(*client)
}

// sessionKey hashes the bearer token into the map key (H1): the raw token was
// the key, so every rotated token left a live entry behind and the map grew
// without bound — and the secret sat in plain text in a key any panic dump
// would print. sha256hex keeps the key injective per token without keeping
// the secret.
func sessionKey(baseURL, token string) string {
	sum := sha256.Sum256([]byte(token))
	return baseURL + "|" + hex.EncodeToString(sum[:])
}

type sessionState struct {
	mu         sync.Mutex
	status     SessionStatus
	instanceID string
	model      string
	expiresAt  time.Time
	position   int64
	queueDepth int64
	pollAfter  time.Time
}

func (m *Manager) stateFor(baseURL, token string) *sessionState {
	key := sessionKey(baseURL, token)
	if v, ok := m.sessions.Load(key); ok {
		return v.(*sessionState)
	}
	st := &sessionState{status: StatusNone}
	actual, _ := m.sessions.LoadOrStore(key, st)
	return actual.(*sessionState)
}

// evictPrevSession deletes the session entry keyed by the PREVIOUS token for
// this base URL, if any (H1). Rotation is normal (the pool refreshes OAuth
// tokens), and without this every rotation left the old entry alive forever:
// an unbounded map keyed by dead secrets.
func (m *Manager) evictPrevSession(baseURL, token string) {
	if prev, ok := m.prevToken.Load(baseURL); ok {
		if prevTok, _ := prev.(string); prevTok != "" && prevTok != token {
			m.sessions.Delete(sessionKey(baseURL, prevTok))
		}
	}
	m.prevToken.Store(baseURL, token)
}

// Chat runs session → root run → chat → finish and returns the upstream
// response for the caller to relay. The request body's model is resolved
// (unavailable → fallback) and its reasoning_effort clamped before sending.
func (m *Manager) Chat(ctx context.Context, baseURL, token, model string, body []byte) (*http.Response, error) {
	c := m.clientFor(baseURL)

	// H1: a rotated token means the previous token's session entry is dead
	// state; evict it before the new one is created.
	m.evictPrevSession(baseURL, token)

	resolved, _ := Resolve(model)
	patched, err := prepareBody(body, resolved)
	if err != nil {
		return nil, &Error{Kind: KindBadRequest, Msg: err.Error()}
	}

	instanceID, err := m.ensureSession(ctx, c, baseURL, token, resolved)
	if err != nil {
		return nil, err
	}

	runID, err := m.ensureRootRun(ctx, c, token)
	if err != nil {
		return nil, err
	}

	resp, err := c.chat(ctx, token, patched, runID, instanceID)
	if err != nil {
		m.finish(c, token, runID)
		return nil, &Error{Kind: KindNetwork, Msg: err.Error()}
	}

	// The run is closed as soon as the upstream answers — the response body is
	// streamed to the client afterwards, exactly as the reference gateway does.
	m.finish(c, token, runID)
	return resp, nil
}

// finish closes a run best-effort; a failure never affects the response.
func (m *Manager) finish(c *client, token, runID string) {
	if runID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = c.finishRun(ctx, token, runID, 1)
}

// ensureRootRun opens a fresh root agent run. Per-request, matching the
// reference implementation: a cached run risks serving an expired run id.
func (m *Manager) ensureRootRun(ctx context.Context, c *client, token string) (string, error) {
	runID, err := c.startRun(ctx, token, RootAgentID)
	if err != nil {
		return "", &Error{Kind: KindUpstream5xx, Msg: err.Error(), RetryAfter: 5}
	}
	return runID, nil
}

// ensureSession returns a live instance id, creating or polling as needed.
func (m *Manager) ensureSession(ctx context.Context, c *client, baseURL, token, model string) (string, error) {
	st := m.stateFor(baseURL, token)
	for attempt := 0; attempt < maxSessionAttempts; attempt++ {
		st.mu.Lock()

		if st.status == StatusActive && st.instanceID != "" && st.model == model {
			if time.Now().Add(sessionGrace).Before(st.expiresAt) {
				id := st.instanceID
				st.mu.Unlock()
				return id, nil
			}
			// Expired: drop it and rebuild.
			st.status = StatusNone
			st.instanceID = ""
		}

		if st.status == StatusQueued && time.Now().Before(st.pollAfter) {
			wait := int(time.Until(st.pollAfter).Seconds())
			if wait < 1 {
				wait = 1
			}
			pos, depth := st.position, st.queueDepth
			st.mu.Unlock()
			return "", &Error{
				Kind:       KindWaitingRoom,
				Msg:        fmt.Sprintf("freebuff waiting room: position %d/%d, retry in %ds", pos, depth, wait),
				RetryAfter: wait,
			}
		}

		prev := st.instanceID
		st.status = StatusNone
		st.mu.Unlock()

		sess, err := c.createSession(ctx, token, model, prev)
		if err != nil {
			return "", &Error{Kind: classifyErr(err), Msg: "freebuff session: " + err.Error()}
		}

		st.mu.Lock()
		status := SessionStatus(sess.Status)
		if status == "" {
			status = StatusNone
		}
		st.status = status
		st.model = model
		switch status {
		case StatusActive:
			st.instanceID = sess.instance()
			st.expiresAt = parseExpiry(sess.ExpiresAt)
			if st.expiresAt.IsZero() {
				st.expiresAt = time.Now().Add(time.Hour)
			}
		case StatusQueued:
			st.instanceID = sess.instance()
			if sess.Position != nil {
				st.position = *sess.Position
			}
			if sess.QueueDepth != nil {
				st.queueDepth = *sess.QueueDepth
			} else {
				st.queueDepth = st.position
			}
			waitMs := int64(5000)
			if sess.EstimatedWaitMs != nil {
				waitMs = *sess.EstimatedWaitMs
			}
			if waitMs < 1000 {
				waitMs = 1000
			}
			if waitMs > 5000 {
				waitMs = 5000
			}
			st.pollAfter = time.Now().Add(time.Duration(waitMs) * time.Millisecond)
		case StatusDisabled:
			st.mu.Unlock()
			return "", &Error{Kind: KindAuthExpired, Msg: "freebuff session disabled: account has no free quota"}
		}
		active := st.status == StatusActive && st.instanceID != ""
		id := st.instanceID
		st.mu.Unlock()

		if active {
			return id, nil
		}
		// Queued or transient: loop, the top of the loop applies the backoff.
	}

	return "", &Error{
		Kind:       KindWaitingRoom,
		Msg:        "freebuff session could not be acquired after repeated attempts",
		RetryAfter: 15,
	}
}

// classifyErr maps an upstream error to a kind, preferring the HTTP status the
// error carries over text matching.
func classifyErr(err error) ErrorKind {
	var he *httpError
	if errors.As(err, &he) {
		return Classify(he.Status, he.Body)
	}
	return Classify(0, err.Error())
}

// prepareBody sets the resolved model and clamps/strips reasoning_effort.
func prepareBody(body []byte, model string) ([]byte, error) {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("freebuff: request body is not a JSON object: %w", err)
	}
	req["model"] = model
	if raw, ok := req["reasoning_effort"].(string); ok {
		if clamped, keep := ClampEffort(model, raw); keep {
			req["reasoning_effort"] = clamped
		} else {
			delete(req, "reasoning_effort")
		}
	}
	return json.Marshal(req)
}
