package routing

// Provider maintenance park.
//
// WHY THIS EXISTS. freemodel.in answers while it is being upgraded with a
// vendor-specific envelope:
//
//	HTTP 503
//	{"error": "FreeModel is being upgraded right now. Please retry in a few minutes - nothing was charged."}
//
// ClassifyUpstream(503) is PROVIDER_UNAVAILABLE + retryable, which is the right
// CLIENT-facing meaning (the provider is temporarily down, the request is not
// at fault). But "retryable" alone is not enough: nothing wrote a cooldown, so
// the very next candidate — and the very next request — picked the same
// provider again. Measured 2026-11-03 19:17–19:37 UTC: 307 of these in 20
// minutes across 58 requests; every one of those requests spent its whole
// 6-attempt budget on prv_freemodel (three provider_model rows × two credential
// rotations each, 32–299 ms per attempt) and never reached a healthy provider
// because there was none in the candidate set. The attempts are cheap
// individually and pure waste in aggregate: a provider that has said "I am
// upgrading" will say it again 60 ms later.
//
// WHAT THIS DOES. A maintenance envelope parks the PROVIDER (not the
// credential, not the provider_model) for MaintenanceParkTTL:
//
//   - provider-scoped, because the envelope is a statement about the whole
//     service, and one freemodel connection is not healthier than its sibling;
//   - short and self-expiring (Valkey TTL), because the message itself says
//     "retry in a few minutes" — the park must lapse on its own, never become a
//     one-way door;
//   - shared across processes (Valkey, spec §12), because the console and the
//     scheduler probe the same upstream.
//
// DEGRADE OPEN, like the circuit breaker: with Valkey down or disabled, nothing
// is parked and the walk behaves exactly as it did before this file existed.
//
// The state rides on the CircuitBreaker because that is the routing layer's
// only handle on shared short-lived state, and both use the same key namespace
// and the same degrade-open rule. It is a SEPARATE key space from
// `circuit:{target}:{id}`: a circuit is per provider_model and opens on a
// failure count, a maintenance park is per provider and opens on one explicit
// vendor message with a TTL the vendor itself implies.

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// maintenanceEnvelopePhrase is the measured freemodel.in maintenance text,
// lowercased. Matching is on this vendor-anchored phrase only — never on
// "upgrade", "maintenance" or "unavailable" alone, because those words appear
// in ordinary per-account refusals from other providers (and in nginx 502
// pages), which must keep their existing classification (spec §9).
const maintenanceEnvelopePhrase = "freemodel is being upgraded right now"

// MaintenanceParkTTL is how long one maintenance envelope takes the provider
// out of admission. Long enough to cover the burst that follows a single
// observation (measured attempts arrive ~10–60 s apart inside one window),
// short enough that the vendor's own "retry in a few minutes" is still
// honoured — a 503 that clears in 30 s costs at most one TTL of avoidance.
const MaintenanceParkTTL = 90 * time.Second

// candidateProviderID is the provider a candidate routes through, or "" when
// the candidate carries no store row (which the catalogue does not produce, but
// the walk must not panic on it).
func candidateProviderID(c *Candidate) string {
	if c == nil || c.Store == nil {
		return ""
	}
	return c.Store.ProviderID
}

// candidateProviderModelID is the provider_model row a candidate routes through,
// or "" when the candidate carries no store row. It is the row-level identity
// for the row-reject park (a 4xx body rejection is a fact about THIS mapping,
// not about the provider or any credential).
func candidateProviderModelID(c *Candidate) string {
	if c == nil || c.Store == nil {
		return ""
	}
	return c.Store.ProviderModelID
}

// maintenanceKey is the park's Valkey key (spec §12 namespaces: this adds
// `maint:` for provider-level maintenance state).
func maintenanceKey(providerID string) string {
	return "maint:provider:" + providerID
}

// maintenanceState is the value stored under maintenanceKey. UntilMs is
// advisory (the TTL is authoritative) but it keeps the stored record
// self-describing for an operator reading Valkey by hand.
type maintenanceState struct {
	ProviderID string `json:"provider_id"`
	UntilMs    int64  `json:"until_ms"`
}

// MaintenanceEnvelope reports whether body is the freemodel.in maintenance
// envelope. It is body-only; the caller gates it on the status it was measured
// at (503) so a differently-shaped 200 or 429 from the same provider keeps its
// own classification.
func MaintenanceEnvelope(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	return strings.Contains(strings.ToLower(string(body)), maintenanceEnvelopePhrase)
}

// ParkMaintenance records that providerID is under maintenance until
// MaintenanceParkTTL elapses. Best-effort: a failure here never fails the
// request that observed the envelope.
func (b *CircuitBreaker) ParkMaintenance(ctx context.Context, providerID string) {
	if b == nil || providerID == "" {
		return
	}
	st := maintenanceState{
		ProviderID: providerID,
		UntilMs:    time.Now().Add(MaintenanceParkTTL).UnixMilli(),
	}
	_ = b.vk.SetJSON(ctx, maintenanceKey(providerID), st, MaintenanceParkTTL)
}

// MaintenanceParked reports whether providerID is currently parked. A missing
// key, a disabled Valkey client, or a transport error all answer false: the
// park only ever REMOVES waste, so it must never block traffic on its own.
func (b *CircuitBreaker) MaintenanceParked(ctx context.Context, providerID string) bool {
	if b == nil || providerID == "" {
		return false
	}
	var st maintenanceState
	if err := b.vk.GetJSON(ctx, maintenanceKey(providerID), &st, 0); err != nil {
		return false
	}
	return st.ProviderID != ""
}

// MaintenanceParkedProviders resolves the park state of every provider in one
// round trip (GetJSONMany). It returns only the providers that ARE parked, so
// the common case — no maintenance anywhere — allocates nothing per provider.
func (b *CircuitBreaker) MaintenanceParkedProviders(ctx context.Context, cands []Candidate) map[string]bool {
	if b == nil || len(cands) == 0 {
		return nil
	}
	ids := make([]string, 0, len(cands))
	seen := make(map[string]bool, len(cands))
	for i := range cands {
		id := candidateProviderID(&cands[i])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = maintenanceKey(id)
	}
	raw := make(map[string]json.RawMessage, len(keys))
	if err := b.vk.GetJSONMany(ctx, keys, raw, 0); err != nil {
		return nil // Valkey down/disabled → nothing parked (degrade open)
	}
	parked := make(map[string]bool, len(raw))
	for i, id := range ids {
		v, ok := raw[keys[i]]
		if !ok {
			continue
		}
		var st maintenanceState
		if err := json.Unmarshal(v, &st); err == nil && st.ProviderID != "" {
			parked[id] = true
		}
	}
	if len(parked) == 0 {
		return nil
	}
	return parked
}

// FilterMaintenanceParked drops candidates whose provider is under a
// maintenance park, preserving order. It NEVER returns an empty set for a
// non-empty input: if every candidate belongs to a parked provider, the
// original list is returned unchanged.
//
// That fail-open is the whole safety argument for parking a provider at
// admission. A provider can be the only target for a model (measured: all 58
// requests in the 2026-11-03 burst were freemodel-only), and a park that
// emptied the candidate set would answer 502 "no routable target" without ever
// asking the upstream — strictly worse than one honest 503. With the fail-open,
// the request still makes exactly ONE attempt against the parked provider (the
// walk then skips its remaining candidates, see Execute) and reports the
// upstream's own answer.
func (b *CircuitBreaker) FilterMaintenanceParked(ctx context.Context, cands []Candidate) []Candidate {
	if b == nil || len(cands) == 0 {
		return cands
	}
	parked := b.MaintenanceParkedProviders(ctx, cands)
	if len(parked) == 0 {
		return cands
	}
	out := make([]Candidate, 0, len(cands))
	for i := range cands {
		if parked[candidateProviderID(&cands[i])] {
			continue
		}
		out = append(out, cands[i])
	}
	if len(out) == 0 {
		return cands
	}
	return out
}

// Row-reject park: a provider_model ROW whose upstream keeps rejecting the
// body (retryable 400 "deserialize"/"duplicate field") is a ROW fact, not a
// credential fact — no credential failed, so nothing else parks it. Without
// this, the row stays servable and is re-picked on every request that ranks
// it: measured 2026-11-03, one tokenjuice row answered 383/383 attempts with
// the same 400 while staying enabled/available, and the model it served read
// request_log p50 88 s because every pick burned a fast 400 then walked into
// the wire timeout. The park is ROW-scoped, short and self-expiring (Valkey
// TTL), and degrade-open exactly like the maintenance park: with Valkey down,
// nothing is parked and the walk behaves as before this file existed.
//
// The TTL is deliberately shorter than MaintenanceParkTTL: a maintenance
// envelope is a service-wide statement that persists for minutes, while a
// body rejection is usually one provider's shape drift that can clear as soon
// as the row is re-probed — and re-probing it after a short bench costs one
// fast 400, not tens of seconds.
const RowRejectParkTTL = 30 * time.Second

// rowRejectKey is the Valkey key for the row-reject park (spec §12 namespace:
// `rowrej:` for provider_model-scoped rejection state).
func rowRejectKey(providerModelID string) string {
	return "rowrej:pmdl:" + providerModelID
}

// ParkRowReject records that providerModelID's upstream rejected its body.
// Best-effort: a failure here never fails the request that observed it.
func (b *CircuitBreaker) ParkRowReject(ctx context.Context, providerModelID string) {
	if b == nil || providerModelID == "" {
		return
	}
	_ = b.vk.SetJSON(ctx, rowRejectKey(providerModelID), map[string]bool{"parked": true}, RowRejectParkTTL)
}

// RowRejectParked reports whether providerModelID is currently parked. A
// missing key, a disabled Valkey client, or a transport error all answer
// false — the park only ever REMOVES waste, so it must never block traffic.
func (b *CircuitBreaker) RowRejectParked(ctx context.Context, providerModelID string) bool {
	if b == nil || providerModelID == "" {
		return false
	}
	var v struct {
		Parked bool `json:"parked"`
	}
	if err := b.vk.GetJSON(ctx, rowRejectKey(providerModelID), &v, 0); err != nil {
		return false
	}
	return v.Parked
}

// FilterRowRejectParked drops candidates whose provider_model row is under a
// row-reject park, preserving order. It NEVER returns an empty set for a
// non-empty input: if every candidate is parked, the original list is
// returned unchanged (the request then still gets one honest attempt against
// the first candidate — same fail-open argument as FilterMaintenanceParked).
func (b *CircuitBreaker) FilterRowRejectParked(ctx context.Context, cands []Candidate) []Candidate {
	if b == nil || len(cands) == 0 {
		return cands
	}
	ids := make([]string, 0, len(cands))
	seen := make(map[string]bool, len(cands))
	for i := range cands {
		id := candidateProviderModelID(&cands[i])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return cands
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = rowRejectKey(id)
	}
	raw := make(map[string]json.RawMessage, len(keys))
	if err := b.vk.GetJSONMany(ctx, keys, raw, 0); err != nil {
		return cands // Valkey down/disabled → nothing parked (degrade open)
	}
	parked := make(map[string]bool, len(raw))
	for i, id := range ids {
		var v struct {
			Parked bool `json:"parked"`
		}
		if err := json.Unmarshal(raw[keys[i]], &v); err == nil && v.Parked {
			parked[id] = true
		}
	}
	if len(parked) == 0 {
		return cands
	}
	out := make([]Candidate, 0, len(cands))
	for i := range cands {
		if parked[candidateProviderModelID(&cands[i])] {
			continue
		}
		out = append(out, cands[i])
	}
	if len(out) == 0 {
		return cands
	}
	return out
}
