package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/routing"
	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

// Model health probing (the "is this model actually serving" surface the
// catalogue lacked). A probe is a REAL one-token chat completion driven through
// the same internal dispatch path a client request takes — candidate
// resolution, credential rotation, upstream exchange — so "ok" means the exact
// path a paying request uses works, not that a mimic says so. Probes create no
// request_log rows and no charges: they never build the request-level
// machinery, only the routing walk.
//
// Storage is one Valkey snapshot key (map slug → record, TTL 40 min) so the
// render path costs ONE read regardless of catalogue size; when Valkey is down
// the last sweep's results survive in-process so the field degrades to
// process-local truth rather than vanishing.
//
// Public surface, strictly opt-in (`?health=1` on both catalogue endpoints):
// the default objects keep the literal §6 P1 field set — exactly
// id/object/owned_by/context/pricing, mirrored 1:1 by the list — so existing
// contract tests and clients see no shape change. The opt-in view adds a
// `health` object {status, latency_ms, checked_at, error?} with status ∈
// ok|down to entries a sweep has reached; entries with no record yet omit the
// field, which is the honest "not probed yet" signal.

const (
	healthVKKey    = "frcat:health:v1"
	healthVKMaxAge = 40 * time.Minute

	// Probe budget: a one-token completion through every stage. 30 s covers
	// the slowest free upstream (measured p95 ~25 s) without letting one
	// dead provider stall the sweep.
	probeTimeout = 30 * time.Second

	defaultSweepInterval = 10 * time.Minute
	probeConcurrency     = 6

	// Render-path view cache: the snapshot refresher and the retry floor on
	// a read failure. 30 s keeps the field within one render window of the
	// sweep; 2 s bounds the retry storm when Valkey is hard-down.
	healthViewTTL      = 30 * time.Second
	healthViewRetryTTL = 2 * time.Second
	healthProbeEnv     = "MODEL_HEALTH_PROBE"    // =off disables the sweeper
	healthIntervalEnv  = "MODEL_HEALTH_INTERVAL" // sweep cadence
)

// HealthEntry is one probe result, as rendered inside a model object.
type HealthEntry struct {
	Status    string    `json:"status"` // "ok" | "down"
	LatencyMs int64     `json:"latency_ms"`
	CheckedAt time.Time `json:"checked_at"`
	ErrCode   string    `json:"error,omitempty"`
}

// probeKey is the synthetic key row ResolveModel needs. UserID is deliberately
// not any real account: account-scoped combos/aliases resolve against an empty
// namespace, so the probe always walks the canonical-slug branch — the same
// candidates a public client gets. No DB row exists; nothing reads it back.
var probeKey = &store.APIKeyRow{ID: "key_health_probe", UserID: "usr_health_probe"}

// healthView loads the current health map (Valkey snapshot, in-process
// fallback). A read failure falls through to the in-memory copy: a non-nil map
// with zero entries means "no data", never "all down".
func (h *Handler) healthView(ctx context.Context) map[string]HealthEntry {
	h.healthViewMu.Lock()
	defer h.healthViewMu.Unlock()
	if h.healthViewCached != nil && time.Now().Before(h.healthViewExp) {
		return h.healthViewCached
	}
	var out map[string]HealthEntry
	if err := h.vk.GetJSON(ctx, healthVKKey, &out, healthVKMaxAge); err == nil && out != nil {
		h.healthViewCached, h.healthViewExp = out, time.Now().Add(healthViewTTL)
		return out
	}
	// Valkey down (or the snapshot absent): fall through to the in-process
	// sweep copy. The negative result is cached briefly so a hard-down Valkey
	// cannot turn every render into a fresh dial; health is minute-scale
	// data, a 2 s staleness is invisible at that grain.
	out = map[string]HealthEntry{}
	h.healthInMem.Range(func(k, v any) bool {
		if e, ok := v.(HealthEntry); ok {
			out[k.(string)] = e
		}
		return true
	})
	h.healthViewCached, h.healthViewExp = out, time.Now().Add(healthViewRetryTTL)
	return out
}

// saveHealth MERGES entries into the latest snapshot and persists it. Merge,
// not replace: a single-probe write (ProbeOnce) must not clobber the sweep's
// other entries, and the sweep's full map is idempotent under merge. A
// concurrent sweep can still last-write-wins the whole snapshot — minute-grain
// eventual consistency is the accepted grain for this data.
func (h *Handler) saveHealth(ctx context.Context, entries map[string]HealthEntry) {
	if len(entries) == 0 {
		return
	}
	latest := map[string]HealthEntry{}
	if err := h.vk.GetJSON(ctx, healthVKKey, &latest, healthVKMaxAge); err != nil || latest == nil {
		latest = map[string]HealthEntry{}
		h.healthInMem.Range(func(k, v any) bool {
			if e, ok := v.(HealthEntry); ok {
				latest[k.(string)] = e
			}
			return true
		})
	}
	for s, e := range entries {
		latest[s] = e
		h.healthInMem.Store(s, e)
	}
	if err := h.vk.SetJSON(ctx, healthVKKey, latest, healthVKMaxAge); err != nil {
		log.Printf("[health] snapshot save failed (in-memory fallback active): %v", err)
	}
}

// attachHealth merges the health view into one rendered object. Known entries
// carry the record; unknown models stay clean on the list (the detail endpoint
// adds the explicit unknown marker itself).
func attachHealth(obj map[string]any, view map[string]HealthEntry) {
	slug, _ := obj["id"].(string)
	if e, ok := view[slug]; ok {
		obj["health"] = e
	}
}

// renderedModelsWithHealth is the opt-in list flavour (`?health=1`). It merges
// the health view at response time from the in-process view cache, so this
// path adds no Valkey read beyond the catalogue's own cachedModels budget; the
// encode is live per request (this flavour is console/diagnostic traffic, not
// the ~1000 rps hot path the plain body's byte-cache exists for).
func (h *Handler) renderedModelsWithHealth(ctx context.Context) ([]byte, bool) {
	models, err := h.cachedModels(ctx)
	if err != nil {
		return nil, false
	}
	view := h.healthView(ctx)
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		obj := modelObject(m)
		attachHealth(obj, view)
		data = append(data, obj)
	}
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]any{"object": "list", "data": data})
	return buf.Bytes(), true
}

// StartHealthSweeper launches the background probe loop. Off with
// MODEL_HEALTH_PROBE=off (tests never call this). One sweep at a time — a slow
// sweep delays the next tick rather than stacking upstream load.
func (h *Handler) StartHealthSweeper(parent context.Context) {
	if strings.EqualFold(os.Getenv(healthProbeEnv), "off") {
		log.Printf("[health] probe disabled by %s=off", healthProbeEnv)
		return
	}
	interval := defaultSweepInterval
	if v := os.Getenv(healthIntervalEnv); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= time.Minute {
			interval = d
		} else {
			log.Printf("[health] bad %s=%q, using %s", healthIntervalEnv, v, interval)
		}
	}
	go func() {
		// First sweep after a short settle: the router may still be filling
		// caches at boot; probing immediately races publish-time renders.
		select {
		case <-time.After(30 * time.Second):
		case <-parent.Done():
			return
		}
		t := time.NewTicker(interval)
		defer t.Stop()
		sweeping := make(chan struct{}, 1)
		for {
			select {
			case <-parent.Done():
				return
			case <-t.C:
				select {
				case sweeping <- struct{}{}:
					go h.runSweep(parent, sweeping)
				default:
					log.Printf("[health] previous sweep still running, skipping tick")
				}
			}
		}
	}()
	log.Printf("[health] sweeper on, interval %s", interval)
}

// runSweep probes one catalogue snapshot. Failures of single probes never
// abort the sweep; the summary line reports coverage so a swept catalogue is
// always distinguishable from an interrupted one. A sweep that is still
// running when the process stops simply ends — the next boot re-probes
// everything (results are a snapshot, not a queue).
func (h *Handler) runSweep(ctx context.Context, done chan struct{}) {
	defer func() { <-done }()
	ctx, cancel := context.WithTimeout(ctx, 25*time.Minute)
	defer cancel()

	models, err := h.cachedModels(ctx)
	if err != nil {
		log.Printf("[health] sweep aborted: catalogue read failed: %v", err)
		return
	}
	slugs := make([]string, 0, len(models))
	for _, m := range models {
		slugs = append(slugs, m.Slug)
	}
	sort.Strings(slugs)

	start := time.Now()
	entries := make(map[string]HealthEntry, len(slugs))
	var mu sync.Mutex
	sem := make(chan struct{}, probeConcurrency)
	var wg sync.WaitGroup
	for _, slug := range slugs {
		wg.Add(1)
		go func(slug string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			e := h.probeModel(ctx, slug)
			mu.Lock()
			entries[slug] = e
			mu.Unlock()
		}(slug)
	}
	wg.Wait()

	h.saveHealth(context.WithoutCancel(ctx), entries)
	ok, down := 0, 0
	for _, e := range entries {
		if e.Status == "ok" {
			ok++
		} else {
			down++
		}
	}
	log.Printf("[health] sweep done: %d models, %d ok, %d down, %s", len(entries), ok, down, time.Since(start).Round(time.Second))
}

// ProbeOnce runs a single probe for slug, persists the result into the health
// snapshot (merged — see saveHealth), and returns it. Without the persist an
// on-demand probe would vanish, leaving the operator-facing surfaces blind to
// what the probe just learned.
func (h *Handler) ProbeOnce(ctx context.Context, slug string) HealthEntry {
	e := h.probeModel(ctx, slug)
	h.saveHealth(ctx, map[string]HealthEntry{slug: e})
	return e
}

// probeModel drives ONE real chat completion for slug through the routing walk.
// The upstream request is the cheapest honest payload: max_tokens 1, stream
// off, no tools. Auth, admission and billing are intentionally NOT exercised —
// model health is an upstream property; those gates have their own surfaces.
func (h *Handler) probeModel(parent context.Context, slug string) HealthEntry {
	ctx, cancel := context.WithTimeout(parent, probeTimeout+10*time.Second)
	defer cancel()
	e := HealthEntry{Status: "down", CheckedAt: time.Now().UTC()}

	pol := store.DefaultRoutingPolicy()
	plan := routing.PlanFromRoutingPolicy(pol, "", false)
	// A health signal is this slug's own truth: one sharp attempt, no
	// cross-model fallback chain diluting which upstream actually failed.
	plan.MaxAttempts = 1
	plan.FallbackEnabled = false

	res, err := h.store.ResolveModel(ctx, probeKey, slug)
	if err != nil {
		e.ErrCode = "model_unresolved"
		return e
	}
	byModel, err := h.store.CandidatesBatch(ctx, res.ModelIDs, res.RequiredCapabilities)
	if err != nil {
		e.ErrCode = "candidates_unreadable"
		return e
	}
	var merged []routing.Candidate
	for _, modelID := range res.ModelIDs {
		for j := range byModel[modelID] {
			c := byModel[modelID][j]
			rc := routing.Candidate{Store: &c}
			rc.LoadSignals()
			merged = append(merged, rc)
		}
	}
	h.fillCandidatePricing(ctx, merged)
	merged = routing.Filter(merged, plan.Constraints)
	if len(merged) == 0 {
		e.ErrCode = "no_routable_candidate"
		return e
	}
	cands := routing.Select(merged, plan)

	lc := &lifecycle{
		h:         h,
		requestID: "probe" + strconv.FormatInt(time.Now().UnixNano(), 10),
		timing:    map[string]int64{},
		pol:       &plan,
		polID:     pol.ID,
	}
	lc.cands = cands
	lc.deadline = time.Now().Add(probeTimeout)
	// exchange reads only the client request's Content-Type (everything else
	// it needs arrives via arguments); a bare request satisfies that read
	// without dragging the user-plane machinery in.
	bareReq, berr := http.NewRequestWithContext(ctx, http.MethodPost, "http://health.probe.local/c", nil)
	if berr != nil {
		e.ErrCode = "probe_request_build"
		return e
	}
	bareReq.Header.Set("Content-Type", "application/json")
	lc.r = bareReq

	upBody := []byte(fmt.Sprintf(`{"model":%q,"stream":false,"max_tokens":1,"messages":[{"role":"user","content":"health probe"}]}`, slug))
	resp, err := lc.dispatch(ctx, upBody, http.MethodPost, "", "/chat/completions")
	if err != nil {
		e.ErrCode = lastAttemptErrCode(lc)
		e.LatencyMs = lastAttemptLatency(lc)
		return e
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		e.ErrCode = fmt.Sprintf("http_%d", resp.StatusCode)
		e.LatencyMs = lastAttemptLatency(lc)
		return e
	}
	var probe struct {
		Choices []json.RawMessage `json:"choices"`
	}
	if json.Unmarshal(body, &probe) != nil || len(probe.Choices) == 0 {
		e.ErrCode = "malformed_ok"
		return e
	}
	e.Status = "ok"
	e.LatencyMs = lastAttemptLatency(lc)
	return e
}

// Attempt facts: dispatch records every exchange as a routing.Attempt on the
// lifecycle, so a failed probe's error code and latency come from the last row.
func lastAttemptErrCode(lc *lifecycle) string {
	if len(lc.attempts) == 0 {
		return "no_attempt"
	}
	if c := lc.attempts[len(lc.attempts)-1].ErrorCode; c != "" {
		return c
	}
	return "no_attempt"
}

// lastAttemptLatency returns the recorded latency of the final attempt row.
func lastAttemptLatency(lc *lifecycle) int64 {
	if len(lc.attempts) == 0 {
		return 0
	}
	return lc.attempts[len(lc.attempts)-1].LatencyMs
}
