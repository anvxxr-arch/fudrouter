package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/vk"
)

// The /v1/models render cache: the endpoint was CPU-bound re-encoding the
// whole catalogue on every request (~3.08 ms/request measured, ~1000 req/s on
// 4 cores while /health did ~8300). These tests pin the four properties the
// cache must keep: the hot path stops allocating the document, the bytes are
// identical to the old encoder's output, the dev-provider flag cannot leak a
// body across states, and the database-error path still answers INTERNAL_ERROR.

func newRenderTestHandler(t *testing.T, dsn, flag string) (*Handler, *vk.Fake) {
	t.Helper()
	ctx := context.Background()
	// Lazy pool: New parses the DSN and reads the flag without dialing, so
	// nothing here may reach the network (port 1 is never a Postgres).
	t.Setenv("ROUTER_ALLOW_DEV_PROVIDERS", flag)
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("store.New(%s): %v", dsn, err)
	}
	t.Cleanup(st.Close)
	fake := vk.NewFake()
	return &Handler{store: st, vk: fake}, fake
}

func seedCatalogue(t *testing.T, h *Handler, fake *vk.Fake, models []store.ModelInfo) {
	t.Helper()
	if err := fake.SetJSON(context.Background(), h.catalogueKey("models:v2"), models, time.Minute); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func sampleModels() []store.ModelInfo {
	return []store.ModelInfo{
		{Slug: "alpha-mini", OwnedBy: "anvxxr", Context: 8192, InputPrice: "150", OutputPrice: "600", Currency: "USD"},
		{Slug: "beta-large", OwnedBy: "anvxxr", Context: 128000, InputPrice: "2500", OutputPrice: "10000", Currency: "USD"},
		{Slug: "gamma-dev", OwnedBy: "dev", Context: 4096, InputPrice: "0", OutputPrice: "0", Currency: "USD"},
	}
}

// expectedModelsBody renders the list the way the pre-cache handler did:
// modelObject per row into the {"object":"list","data":…} envelope.
func expectedModelsBody(models []store.ModelInfo) []byte {
	data := make([]map[string]any, 0, len(models)*2)
	for _, m := range models {
		obj := modelObject(m)
		data = append(data, obj)
		// The catalogue also renders each model's `-unrestricted` virtual
		// twin (unrestricted.go) — the golden body must include it.
		if u := unrestrictedTwin(obj); u != nil {
			data = append(data, u)
		}
	}
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]any{"object": "list", "data": data})
	return buf.Bytes()
}

func serveModelsOnce(h *Handler) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeModels(w, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	return w
}

// collectAnswers waits for want results on errs, failing the test if they do
// not arrive: a concurrent request that never answers is queueing behind the
// in-flight refresh instead of being served the stale body.
func collectAnswers(t *testing.T, errs <-chan error, want int) {
	t.Helper()
	for range want {
		select {
		case err := <-errs:
			if err != nil {
				t.Fatalf("concurrent request failed: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("concurrent request did not answer within 5s: callers are queueing behind the refresh instead of serving the stale body")
		}
	}
}

// TestModelsRenderCacheStopsAllocating is the regression gate: after one warm
// render, a repeat request must not rebuild the document. Before the cache
// this measured ~3,400 allocations per request (342 outer maps + 342 nested
// pricing maps + the encoder's reflection churn); the threshold is set far
// below that and far above the handful a cached w.Write costs.
func TestModelsRenderCacheStopsAllocating(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())

	// Warm render.
	if w := serveModelsOnce(h); w.Code != http.StatusOK {
		t.Fatalf("warm render: status %d body %s", w.Code, w.Body.String())
	}
	n := testing.AllocsPerRun(10, func() {
		serveModelsOnce(h)
	})
	t.Logf("allocs per warm request: %g", n)
	if n >= 50 {
		t.Fatalf("ServeModels still allocates %g allocs/request on the warm path (cache not engaged)", n)
	}
}

// TestModelsRenderCacheByteIdentical requires the cached body to be exactly
// what the original modelObject + json.Encoder path emitted — no field
// reorder, no added fields, no envelope change.
func TestModelsRenderCacheByteIdentical(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	models := sampleModels()
	seedCatalogue(t, h, fake, models)

	w := serveModelsOnce(h)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	want := expectedModelsBody(models)
	if !bytes.Equal(w.Body.Bytes(), want) {
		t.Errorf("body drift:\n got: %s\nwant: %s", w.Body.String(), want)
	}
}

// TestModelsRenderCacheIsolatesDevFlag: devProviders() changes which models
// are listed, so a body rendered under one flag must never be served under
// the other. The catalogue key already isolates the two lists in Valkey; this
// pins the same rule on the render cache.
func TestModelsRenderCacheIsolatesDevFlag(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())

	off := serveModelsOnce(h)
	if off.Code != http.StatusOK {
		t.Fatalf("off render: status %d", off.Code)
	}

	// Poison the cache with a body tagged as rendered under the OTHER flag
	// state. A naive cache (body only, no dev stored beside it) would serve
	// these bytes to every later request; the real cache must treat the
	// mismatch as a miss and re-render the current flag's list.
	h.renderMu.Lock()
	h.render, h.renderDev = []byte("POISONED-DEV-BODY"), true
	h.renderMu.Unlock()

	on := serveModelsOnce(h)
	if on.Code != http.StatusOK {
		t.Fatalf("on render: status %d", on.Code)
	}
	if bytes.Equal(on.Body.Bytes(), []byte("POISONED-DEV-BODY")) {
		t.Fatal("served a body tagged with the wrong dev flag: the render cache leaked across flag states")
	}
	if !bytes.Equal(on.Body.Bytes(), expectedModelsBody(sampleModels())) {
		t.Fatal("dev-flag mismatch miss did not re-render the current flag's list")
	}
}

// TestModelsRenderCacheErrorPath: a catalogue that cannot be read must still
// answer INTERNAL_ERROR with the same message the pre-cache handler used.
func TestModelsRenderCacheErrorPath(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	// No seed: the Valkey read misses and ActiveModels fails against the dead
	// DSN. FailAll makes the fake behave like a dead server so nothing can
	// short-circuit into a cached entry.
	fake.FailAll()

	w := serveModelsOnce(h)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500; body %s", w.Code, w.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if env.Error.Code != "INTERNAL_ERROR" || env.Error.Message != "database error" {
		t.Fatalf("error envelope = %q / %q, want INTERNAL_ERROR / database error", env.Error.Code, env.Error.Message)
	}
}

// TestModelsRenderCacheServesStaleOnDBFailure: once a body exists, a
// catalogue read failure serves the previous bytes instead of 500ing a public
// endpoint.
func TestModelsRenderCacheServesStaleOnDBFailure(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())

	first := serveModelsOnce(h)
	if first.Code != http.StatusOK {
		t.Fatalf("first render: status %d", first.Code)
	}
	fake.FailAll()
	stale := serveModelsOnce(h)
	if stale.Code != http.StatusOK || !bytes.Equal(stale.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("stale serve: status %d, body matches first=%v", stale.Code, bytes.Equal(stale.Body.Bytes(), first.Body.Bytes()))
	}
}

// TestModelsRenderCacheSingleRenderOnExpiry: N concurrent requests landing on
// an expired entry must produce one render, not N — the herd is answered from
// the stale body while a single goroutine re-renders, instead of stampeding
// the DB and CPU.
func TestModelsRenderCacheSingleRenderOnExpiry(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())

	if w := serveModelsOnce(h); w.Code != http.StatusOK {
		t.Fatalf("warm: status %d", w.Code)
	}
	h.renderExp = time.Now().Add(-time.Second) // force expiry

	// Hold the refresh winner inside the catalogue read until the other n-1
	// callers are provably past the TryLock, so "one render per window" is a
	// deterministic count rather than a hope about goroutine scheduling.
	gate := make(chan struct{})
	counter := &readCounter{Client: fake, gate: gate}
	h.vk = counter

	const n = 8
	start := make(chan struct{})
	errs := make(chan error, n)
	for range n {
		go func() {
			<-start
			w := serveModelsOnce(h)
			if w.Code != http.StatusOK {
				errs <- errors.New(w.Body.String())
				return
			}
			errs <- nil
		}()
	}
	close(start)

	// The n-1 losers are answered from the stale body without touching the
	// catalogue; only then may the single in-flight render complete.
	collectAnswers(t, errs, n-1)
	close(gate)
	collectAnswers(t, errs, 1)

	if reads := counter.count(); reads != 1 {
		t.Fatalf("expiry window triggered %d catalogue reads across %d concurrent requests (want 1): the herd stampeded the catalogue instead of sharing one render", reads, n)
	}
}

// readCounter wraps a vk.Client and counts GetJSON calls. cachedModels makes
// exactly one GetJSON per invocation, so the count is the number of refresh
// attempts — the property the single-flight gate must cap at one per batch.
// A non-nil gate blocks the first counted read until it closes, letting a
// test hold the refresh winner inside the catalogue read while the rest of
// the herd is provably past the TryLock: the read count is then structural,
// not a scheduler-dependent tolerance.
type readCounter struct {
	vk.Client
	mu    sync.Mutex
	reads int
	gate  chan struct{}
}

func (c *readCounter) GetJSON(ctx context.Context, key string, v any, ttl time.Duration) error {
	c.mu.Lock()
	c.reads++
	first := c.reads == 1
	c.mu.Unlock()
	if first && c.gate != nil {
		select {
		case <-c.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return c.Client.GetJSON(ctx, key, v, ttl)
}

func (c *readCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads
}

// TestModelsRenderCacheServesStaleWithoutQueueing: with an expired entry and
// a failing catalogue read, the stale body must be served to every caller
// while the refresh is attempted ONCE for the whole batch. The old shape ran
// the stale-serve inside the renderOnce gate, so on a DB outage every request
// queued behind the one failing read and then re-ran it itself — a public
// endpoint serializing into a queue of failing DB reads with a perfectly
// good body sitting in h.render.
func TestModelsRenderCacheServesStaleWithoutQueueing(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())

	// Warm render so h.render is populated. The counter is armed afterwards,
	// so its first counted read is the batch's refresh winner.
	warm := serveModelsOnce(h)
	if warm.Code != http.StatusOK {
		t.Fatalf("warm render: status %d body %s", warm.Code, warm.Body.String())
	}
	warmBody := warm.Body.Bytes()

	// Force expiry, then make the catalogue read fail from now on.
	h.renderExp = time.Now().Add(-time.Second)
	fake.FailAll()

	// The gate holds the winner inside the failing read until the test has
	// collected the other n-1 answers, so the herd is provably past the
	// TryLock while the lock is held: every loser must be answered from the
	// stale body, and the batch must cost exactly one refresh attempt.
	gate := make(chan struct{})
	counter := &readCounter{Client: fake, gate: gate}
	h.vk = counter

	const n = 8
	start := make(chan struct{})
	errs := make(chan error, n)
	for range n {
		go func() {
			<-start
			w := serveModelsOnce(h)
			if w.Code != http.StatusOK {
				errs <- errors.New(w.Body.String())
				return
			}
			if !bytes.Equal(w.Body.Bytes(), warmBody) {
				errs <- errors.New("body drifted from the warm render")
				return
			}
			errs <- nil
		}()
	}
	close(start)

	// The n-1 losers answer from the stale body without touching the
	// catalogue; only then may the single in-flight refresh attempt fail.
	collectAnswers(t, errs, n-1)
	close(gate)
	collectAnswers(t, errs, 1)

	// The structural property that proves no queueing: with cachedModels
	// failing, an in-flight refresh must be attempted exactly once for the
	// batch — the gate above makes that count deterministic instead of a
	// scheduler-dependent tolerance.
	reads := counter.count()
	t.Logf("cachedModels attempts for %d concurrent requests on an expired entry with a failing read: %d", n, reads)
	if reads != 1 {
		t.Fatalf("batch of %d requests triggered %d catalogue reads (want 1): requests are queueing behind the failing refresh instead of serving the stale body", n, reads)
	}
}

// TestModelsRenderCacheFreshEntrySkipsRead: a fresh entry must not touch the
// catalogue at all — the happy path takes one renderMu acquisition and never
// reaches cachedModels, so N concurrent requests cost zero reads.
func TestModelsRenderCacheFreshEntrySkipsRead(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	seedCatalogue(t, h, fake, sampleModels())
	counter := &readCounter{Client: fake}
	h.vk = counter

	if w := serveModelsOnce(h); w.Code != http.StatusOK {
		t.Fatalf("warm render: status %d body %s", w.Code, w.Body.String())
	}
	base := counter.count()

	const n = 8
	errs := make(chan error, n)
	for range n {
		go func() {
			w := serveModelsOnce(h)
			if w.Code != http.StatusOK {
				errs <- errors.New(w.Body.String())
				return
			}
			errs <- nil
		}()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent request failed: %v", err)
		}
	}
	if reads := counter.count() - base; reads != 0 {
		t.Fatalf("fresh entry triggered %d catalogue reads across %d requests (want 0)", reads, n)
	}
}

// TestModelsRenderCacheExpiryRebuilds: after the 45 s window the cache must
// re-render, not serve forever — publish latency is bounded by the same
// window the Valkey entry uses.
func TestModelsRenderCacheExpiryRebuilds(t *testing.T) {
	h, fake := newRenderTestHandler(t, "postgres://u:p@127.0.0.1:1/dead", "")
	models := sampleModels()
	seedCatalogue(t, h, fake, models)

	if w := serveModelsOnce(h); w.Code != http.StatusOK {
		t.Fatalf("warm: status %d", w.Code)
	}
	// Publish a new model into the fake catalogue, then expire the render.
	models = append(models, store.ModelInfo{Slug: "delta-new", OwnedBy: "anvxxr", Context: 4096, InputPrice: "10", OutputPrice: "20", Currency: "USD"})
	seedCatalogue(t, h, fake, models)
	h.renderExp = time.Now().Add(-time.Second)

	w := serveModelsOnce(h)
	if w.Code != http.StatusOK {
		t.Fatalf("rebuild: status %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "delta-new") {
		t.Fatal("expired cache served the old list after publish")
	}
	if !bytes.Equal(w.Body.Bytes(), expectedModelsBody(models)) {
		t.Fatal("rebuilt body drifted from the encoder path")
	}
}
