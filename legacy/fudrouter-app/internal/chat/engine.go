package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/internal/db"
)

type Engine struct {
	DB          *db.DB
	Client      *http.Client
	MaxRace     int
	RaceTimeout time.Duration
	Cooldown      time.Duration

	mu    sync.Mutex
	track map[string]*tracker
}

type tracker struct {
	DisabledUntil time.Time
	Status        string
	Failures      int
}

func New(database *db.DB) *Engine {
	return &Engine{
		DB: database,
		Client: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				MaxIdleConns:        100,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 5 * time.Second,
				ForceAttemptHTTP2:   true,
			},
		},
		MaxRace:     4,
		RaceTimeout: 30 * time.Second,
		Cooldown:      60 * time.Second,
		track:       map[string]*tracker{},
	}
}

func DetectProvider(model string) string {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return ""
	}
	if i := strings.IndexByte(m, '/'); i > 0 {
		return m[:i]
	}
	switch {
	case strings.HasPrefix(m, "claude"):
		return "anthropic"
	case strings.HasPrefix(m, "gpt"), strings.HasPrefix(m, "o1"), strings.HasPrefix(m, "o3"), strings.HasPrefix(m, "o4"):
		return "openai"
	case strings.HasPrefix(m, "gemini"):
		return "google"
	case strings.HasPrefix(m, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(m, "qwen"), strings.HasPrefix(m, "qwq"):
		return "qwen"
	case strings.HasPrefix(m, "mistral"):
		return "mistral"
	case strings.HasPrefix(m, "grok"):
		return "xai"
	case strings.HasPrefix(m, "kimi"):
		return "moonshot"
	case strings.HasPrefix(m, "opencode"), strings.HasPrefix(m, "zen"):
		return "opencode-zen"
	case strings.HasPrefix(m, "glm"):
		return "zhipu"
	default:
		return ""
	}
}

func (e *Engine) disabled(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, ok := e.track[id]
	if !ok {
		return false
	}
	if t.DisabledUntil.IsZero() {
		return false
	}
	if time.Now().After(t.DisabledUntil) {
		t.DisabledUntil = time.Time{}
		t.Status = "active"
		return false
	}
	return true
}

func (e *Engine) markFail(id string, code, retryAfter int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.track[id]
	if t == nil {
		t = &tracker{}
		e.track[id] = t
	}
	t.Failures++
	now := time.Now()
	switch {
	case code == 429:
		d := e.Cooldown
		if retryAfter > 0 {
			d = time.Duration(retryAfter) * time.Second
		}
		t.DisabledUntil = now.Add(d)
		t.Status = "rate_limited"
	case code == 401 || code == 403:
		t.DisabledUntil = now.Add(24 * time.Hour)
		t.Status = "auth_error"
	case code >= 500 || code == 408:
		t.DisabledUntil = now.Add(5 * time.Second)
		t.Status = "server_error"
	}
}

func (e *Engine) markOK(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.track[id]
	if t == nil {
		t = &tracker{}
		e.track[id] = t
	}
	t.Failures = 0
	t.Status = "active"
	t.DisabledUntil = time.Time{}
}

func strField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
	}
	return ""
}

func resolveCreds(c db.Connection) (baseURL, apiKey string) {
	baseURL = c.BaseURL
	apiKey = c.APIKey
	if baseURL == "" {
		baseURL = strField(c.Data, "baseUrl", "base_url", "endpoint")
	}
	if apiKey == "" {
		apiKey = strField(c.Data, "apiKey", "api_key", "accessToken", "token")
	}
	return baseURL, apiKey
}

func chatURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, "/v1/chat/completions") {
		path += "/v1/chat/completions"
	}
	u.Path = path
	return u.String(), nil
}

type Result struct {
	ConnID string
	Status int
	Header http.Header
	Body   io.ReadCloser
	Err    error
	Code   int
	Retry  int
}

func (e *Engine) attempt(ctx context.Context, c db.Connection, body []byte) Result {
	base, key := resolveCreds(c)
	if base == "" {
		return Result{ConnID: c.ID, Err: errors.New("missing baseUrl"), Code: 503}
	}
	if key == "" {
		return Result{ConnID: c.ID, Err: errors.New("missing apiKey"), Code: 401}
	}
	endpoint, err := chatURL(base)
	if err != nil {
		return Result{ConnID: c.ID, Err: err, Code: 400}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{ConnID: c.ID, Err: err, Code: 500}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "fudrouter-go/0.1")

	resp, err := e.Client.Do(req)
	if err != nil {
		code := 503
		if errors.Is(err, context.DeadlineExceeded) {
			code = 408
		}
		return Result{ConnID: c.ID, Err: err, Code: code}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Result{ConnID: c.ID, Status: resp.StatusCode, Header: resp.Header.Clone(), Body: resp.Body}
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	_ = resp.Body.Close()
	ra := 0
	if v := resp.Header.Get("Retry-After"); v != "" {
		ra, _ = strconv.Atoi(v)
	}
	return Result{ConnID: c.ID, Err: fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b)), Code: resp.StatusCode, Retry: ra}
}

// CompleteFillFirst tries connections by priority, zero artificial delay.
func (e *Engine) CompleteFillFirst(ctx context.Context, provider string, body []byte) (Result, error) {
	conns, err := e.DB.ActiveConnections(provider)
	if err != nil {
		return Result{}, err
	}
	var pool []db.Connection
	for _, c := range conns {
		if e.disabled(c.ID) {
			continue
		}
		pool = append(pool, c)
	}
	if len(pool) == 0 {
		return Result{}, errors.New("no active connections for provider " + provider)
	}
	var last error
	for _, c := range pool {
		r := e.attempt(ctx, c, body)
		if r.Err == nil && r.Body != nil {
			e.markOK(c.ID)
			return r, nil
		}
		last = r.Err
		e.markFail(c.ID, r.Code, r.Retry)
	}
	if last == nil {
		last = errors.New("all connections failed")
	}
	return Result{}, last
}

// CompleteRace races top N healthy keys.
func (e *Engine) CompleteRace(ctx context.Context, provider string, body []byte) (Result, error) {
	conns, err := e.DB.ActiveConnections(provider)
	if err != nil {
		return Result{}, err
	}
	var pool []db.Connection
	for _, c := range conns {
		if e.disabled(c.ID) {
			continue
		}
		pool = append(pool, c)
		if len(pool) >= e.MaxRace {
			break
		}
	}
	if len(pool) == 0 {
		return Result{}, errors.New("no active connections for provider " + provider)
	}
	ctx, cancel := context.WithTimeout(ctx, e.RaceTimeout)
	defer cancel()
	ch := make(chan Result, len(pool))
	var wg sync.WaitGroup
	for _, c := range pool {
		wg.Add(1)
		go func(c db.Connection) {
			defer wg.Done()
			ch <- e.attempt(ctx, c, body)
		}(c)
	}
	go func() {
		wg.Wait()
		close(ch)
	}()
	var last error
	for r := range ch {
		if r.Err == nil && r.Body != nil {
			e.markOK(r.ConnID)
			go func() {
				for rest := range ch {
					if rest.Body != nil {
						_ = rest.Body.Close()
					}
				}
			}()
			cancel()
			return r, nil
		}
		if r.Err != nil {
			last = r.Err
			e.markFail(r.ConnID, r.Code, r.Retry)
		}
	}
	if last == nil {
		last = errors.New("all connections failed")
	}
	return Result{}, last
}

func ParseModel(body []byte) (model, provider string) {
	var m map[string]any
	_ = json.Unmarshal(body, &m)
	if v, ok := m["model"].(string); ok {
		model = v
		provider = DetectProvider(v)
	}
	if v, ok := m["provider"].(string); ok && v != "" {
		provider = v
	}
	return
}
