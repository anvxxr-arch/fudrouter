package proxy

import (
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
	"time"

	"github.com/anvxxr-arch/fudrouter/apps/router/internal/cost"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/freebuff"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/ids"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/limits"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/routing"
	"github.com/anvxxr-arch/fudrouter/apps/router/internal/store"
)

// lifecycle carries ONE request through PRD §85: authenticate → limits →
// budget → resolve model → route → attempt(s) → record → charge. Every
// /v1/* entry point runs the same machinery so a new endpoint cannot skip
// billing, the ledger or the error taxonomy.
type lifecycle struct {
	h *Handler
	r *http.Request
	w http.ResponseWriter

	start     time.Time
	requestID string
	endpoint  string
	requested string // the raw `model` string, or "" for non-model endpoints

	key  *store.APIKeyRow
	lim  *store.Limits
	pol  *routing.Plan
	polID string

	resolved *store.ModelResolution
	cands    []routing.Candidate

	deadline time.Time
	timing   map[string]int64

	stream             bool
	clientDisconnected bool
	streamTTFT         *int

	// admission holds the concurrency slot for the request's lifetime.
	admission interface{ Release() }
	// cancelUpstream releases the non-streaming request bound.
	cancelUpstream func()

	attempts  []*routing.Attempt
	pricing   *store.Pricing
	usage     usageCounts
	usageSeen bool

	status    string // spec §8 vocabulary
	errCode   string
	errMsg    string
	rawErr    string // raw upstream text: request_log.error only (spec §8)
	httpStat  int

	// anthropic makes the error envelope the Anthropic shape
	// ({"type":"error","error":{…}}) instead of the [OI] one — the /v1/messages
	// surface (anthropic.go) sets it so a rejection is parseable by an
	// Anthropic client. Success bodies are translated by anthropic.go.
	anthropic bool

	finished bool
}

// usageCounts is the provider-reported usage of one request (PRD §87, §122).
type usageCounts struct {
	TokensIn          int64
	CachedInputTokens int64
	TokensOut         int64
	ReasoningTokens   int64
	TotalTokens       int64
}

// validateFunc is the endpoint-specific body/path validation. It runs AFTER
// authentication and the key-policy gates (so an invalid key is 401 on every
// path — endpoint-surface spec §3.1) and BEFORE the limit counters (so a
// malformed body does not burn a request from the key's window).
//
// It returns the routing key (the body's `model`, or "" for non-model
// endpoints) and a rejection to answer with, if any.
type validateFunc func(body []byte) (slug string, reject *apiError)

// begin runs the admission half of the lifecycle. It answers the client itself
// on every rejection and returns ok=false there; on success the caller MUST
// call finish (defer it). `anthropic` shapes rejections like the Anthropic API.
func (h *Handler) begin(w http.ResponseWriter, r *http.Request, start time.Time, endpoint string, body []byte, validate validateFunc, anthropic bool) (*lifecycle, bool) {
	lc := &lifecycle{
		h:         h,
		r:         r,
		w:         w,
		start:     start,
		requestID: ids.New("req"),
		endpoint:  endpoint,
		timing:    map[string]int64{},
		anthropic: anthropic,
	}
	// The request id is on EVERY response, success or failure (PRD §90), so a
	// client can correlate an error with its request_log row.
	w.Header().Set("x-fudrouter-request-id", lc.requestID)

	authStart := time.Now()
	key, err := h.authenticate(r)
	if err != nil {
		if errors.Is(err, errAuthRateLimited) {
			lc.reject(routing.ErrCodeRateLimited, err.Error(), "rate_limited", http.StatusTooManyRequests)
			return lc, false
		}
		lc.reject(routing.ErrCodeAuthError, err.Error(), "client_error", int(statusCodeFor(routing.ErrCodeAuthError)))
		return lc, false
	}
	lc.key = key

	// Policy gates that belong to the key itself (spec §3): endpoint allowlist,
	// IP allowlist.
	if err := lc.checkPolicy(r); err != nil {
		lc.reject(routing.ErrCodeAuthorization, err.Error(), "client_error", int(statusCodeFor(routing.ErrCodeAuthorization)))
		return lc, false
	}
	lc.timing["auth"] = time.Since(authStart).Milliseconds()

	// Endpoint-specific validation (body shape, path support): a truthful 404
	// for an unimplemented path (spec §14 promise #5) or 400 for a bad body.
	slug, rejection := validate(body)
	lc.requested = slug
	if rejection != nil {
		lc.reject(rejection.Code, rejection.Message, "client_error", rejection.Status)
		return lc, false
	}

	limStart := time.Now()
	lim, err := h.store.EffectiveLimits(r.Context(), key)
	if err != nil {
		// A limit lookup failure must not fail the request (fail open, spec
		// §12): log and continue unbounded at this level.
		log.Printf("[proxy] limit resolution failed for key %s: %v", key.ID, err)
		lim = &store.Limits{}
	}
	lc.lim = lim

	adm, rej := h.limiter.Check(r.Context(),
		&limits.APIKeyIdentity{KeyID: key.ID, WorkspaceID: key.WorkspaceID, Store: h.store},
		lim, tokenEstimate(body))
	if rej != nil {
		status := "rate_limited"
		if rej.HTTPStatus == http.StatusPaymentRequired {
			status = "client_error"
		}
		lc.reject(rej.Code, rej.Message, status, rej.HTTPStatus)
		return lc, false
	}
	// The concurrency slot lives for the whole request.
	lc.admission = adm

	// Budget gate (spec §7/§10): thresholds raise alerts; 100% + block rejects.
	if err := h.checkBudgets(r.Context(), lc); err != nil {
		lc.reject(routing.ErrCodeInsufficientCredits, err.Error(), "client_error", http.StatusPaymentRequired)
		return lc, false
	}
	lc.timing["rate_limit"] = time.Since(limStart).Milliseconds()

	routeStart := time.Now()
	pol, err := h.cachedRoutingPolicy(r.Context(), key)
	if err != nil {
		pol = store.DefaultRoutingPolicy()
	}
	strategyOverride := ""
	// The strategy header lets a caller override the stored routing policy's
	// strategy, so it is off by default and must be opted into with
	// ROUTER_ALLOW_STRATEGY_HEADER=on. Left unset, the header is ignored
	// entirely: only an operator who knows what a strategy does to routing may
	// hand that choice to clients.
	if strings.EqualFold(strings.TrimSpace(os.Getenv("ROUTER_ALLOW_STRATEGY_HEADER")), "on") {
		strategyOverride = r.Header.Get("x-fudrouter-strategy")
	}
	plan := routing.PlanFromRoutingPolicy(pol, strategyOverride, false)
	lc.pol, lc.polID = &plan, pol.ID

	if slug != "" {
		res, err := h.store.ResolveModel(r.Context(), key, slug)
		if err != nil {
			code := routing.ErrCodeModelNotFound
			if !errors.Is(err, store.ErrNotFound) {
				code = routing.ErrCodeInternalError
			}
			lc.reject(code, "unknown model: "+slug, "client_error", int(statusCodeFor(code)))
			return lc, false
		}
		if err := lc.checkModelPolicy(res); err != nil {
			lc.reject(routing.ErrCodeAuthorization, err.Error(), "client_error", http.StatusForbidden)
			return lc, false
		}
		lc.resolved = res

		// Candidates: capability filter first (spec §5), then constraints and
		// scoring (spec §9).
		var merged []routing.Candidate
		for i, modelID := range res.ModelIDs {
			cands, err := h.store.Candidates(r.Context(), modelID, res.RequiredCapabilities)
			if err != nil {
				continue // no routable target for this model: try the next
			}
			for j := range cands {
				c := cands[j]
				rc := routing.Candidate{Store: &c}
				rc.LoadSignals()
				merged = append(merged, rc)
			}
			_ = i
		}
		// Per-candidate prices drive the cost-aware strategies. Resolved here
		// through the shared fillCandidatePricing helper (fail-open to DB) so N
		// candidates cost N cache hits instead of N pricing queries; the
		// request's own billing snapshot in buildRow is untouched.
		h.fillCandidatePricing(r.Context(), merged)
		// The alias's own target order is the model preference when the policy
		// declares none (spec §5: alias targets are ordered by position).
		if len(plan.ModelPref.Order) == 0 && res.Kind == "alias" {
			plan.ModelPref.Order = append([]string(nil), res.ModelSlugs...)
		}
		merged = routing.Filter(merged, plan.Constraints)
		if len(merged) == 0 {
			lc.reject(routing.ErrCodeModelNotFound,
				"no candidate satisfies the request constraints for "+slug,
				"provider_error", http.StatusNotFound)
			return lc, false
		}
		lc.cands = routing.Select(merged, plan)
	}
	lc.timing["routing"] = time.Since(routeStart).Milliseconds()

	// The request deadline (spec §9): request_timeout_ms is absolute, and no
	// attempt may start that cannot finish inside it.
	lc.deadline = start.Add(time.Duration(plan.RequestTimeoutMs) * time.Millisecond)
	return lc, true
}

// tokenEstimate is the caller's own upper bound on output tokens (`max_tokens`
// / `max_completion_tokens`). The router does not count tokens (PRD §87: it
// bills what the upstream reports), so the TPM window is checked against the
// bound the CLIENT declared — and skipped when it declared none.
func tokenEstimate(body []byte) int64 {
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		return 0
	}
	for _, k := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if v, ok := req[k].(float64); ok && v > 0 {
			return int64(v)
		}
	}
	return 0
}

// checkPolicy enforces the key policy gates that need no routing decision
// (spec §3): endpoint allowlist, IP allowlist. A policy that says nothing is
// permissive (missing field = inherit, and there is nothing above to inherit).
func (lc *lifecycle) checkPolicy(r *http.Request) error {
	p := lc.key.Policy

	if len(p.Endpoints) > 0 && !contains(p.Endpoints, lc.endpoint) {
		return fmt.Errorf("this API key may not use %s", lc.endpoint)
	}
	if len(p.IPAllowlist) > 0 {
		ip := clientIP(r)
		if ip == "" || !ipAllowed(p.IPAllowlist, ip) {
			return fmt.Errorf("client IP is not in this API key's allowlist")
		}
	}
	return nil
}

// checkModelPolicy enforces the model/alias allowlists of the key policy
// (spec §3). The raw string is matched so an allowlist can name an alias.
func (lc *lifecycle) checkModelPolicy(res *store.ModelResolution) error {
	p := lc.key.Policy
	if len(p.Models) == 0 && len(p.Aliases) == 0 {
		return nil
	}
	allowed := false
	if contains(p.Aliases, res.Requested) {
		allowed = true
	}
	for _, slug := range res.ModelSlugs {
		if contains(p.Models, slug) {
			allowed = true
		}
	}
	if contains(p.Models, res.Requested) {
		allowed = true
	}
	if !allowed {
		return fmt.Errorf("this API key may not use model %s", res.Requested)
	}
	return nil
}

// TrustedProxiesEnv lists the ingress addresses whose X-Forwarded-For entries
// may be believed, as a comma-separated list of IPs and CIDRs. It is the
// operator's declaration of "my TLS terminates here" — the same rule the
// control plane's writeAudit follows, but made explicit instead of trusting
// whoever spoke first.
const TrustedProxiesEnv = "ROUTER_TRUSTED_PROXIES"

// trustedProxies is parsed once at startup from TrustedProxiesEnv. Empty means
// trust nothing: X-Forwarded-For is ignored entirely and clientIP falls back to
// RemoteAddr, which is the one address the router itself observed. Leaving the
// var unset therefore fails CLOSED — a client that forges
// `X-Forwarded-For: 1.2.3.4` cannot defeat a key's ip_allowlist or poison the
// request_log rows when the operator has not declared a proxy.
var trustedProxies = parseTrustedProxies(os.Getenv(TrustedProxiesEnv))

// parseTrustedProxies turns the env value into subnets. A bare IP becomes a
// /32 or /128 so every entry is one comparable *net.IPNet. Malformed entries
// are dropped rather than fatal: a typo must not stop the data plane, and the
// safe direction of a dropped entry is that its hop is treated as untrusted.
func parseTrustedProxies(spec string) []*net.IPNet {
	var out []*net.IPNet
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, subnet, err := net.ParseCIDR(part); err == nil {
			out = append(out, subnet)
			continue
		}
		if ip := net.ParseIP(part); ip != nil {
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return out
}

// isTrustedProxy reports whether addr is one of the declared ingress hops.
func isTrustedProxy(addr string) bool {
	ip := net.ParseIP(strings.TrimSpace(addr))
	if ip == nil {
		return false
	}
	for _, subnet := range trustedProxies {
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP extracts the request's client address by walking X-Forwarded-For
// from RIGHT to LEFT, skipping every entry that is a trusted proxy
// (ROUTER_TRUSTED_PROXIES, comma-separated IPs/CIDRs), and returning the first
// address that is not. The header is walked ONLY when the socket peer itself
// is a declared proxy — a direct caller forging X-Forwarded-For gets its peer
// address, never the forged value (fail closed, same gate as the React
// plane's clientIp). With no XFF, or with every entry a trusted proxy, it
// falls back to the peer host. Unparseable → "".
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := strings.TrimSpace(host)
	// The header is believed only when the socket peer is a declared proxy:
	// otherwise any direct caller could forge X-Forwarded-For and defeat a
	// key's ip_allowlist (or poison request_log.client_ip). An untrusted peer
	// means the peer itself is the client — the same gate the React plane
	// uses (server/lib/ip.mjs clientIp).
	if !isTrustedProxy(peer) {
		if ip := net.ParseIP(peer); ip != nil {
			return ip.String()
		}
		return ""
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		hops := strings.Split(xff, ",")
		for i := len(hops) - 1; i >= 0; i-- {
			hop := strings.TrimSpace(hops[i])
			if hop == "" {
				continue
			}
			if isTrustedProxy(hop) {
				continue
			}
			if ip := net.ParseIP(hop); ip != nil {
				return ip.String()
			}
		}
	}
	if ip := net.ParseIP(peer); ip != nil {
		return ip.String()
	}
	return ""
}

// ipAllowed matches a dotted/CIDR allowlist (spec §3 `ip_allowlist`).
func ipAllowed(list []string, ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, entry := range list {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, subnet, err := net.ParseCIDR(entry)
			if err == nil && subnet.Contains(ip) {
				return true
			}
			continue
		}
		if parsed := net.ParseIP(entry); parsed != nil && parsed.Equal(ip) {
			return true
		}
	}
	return false
}

// reject answers a client-side rejection and arms the ledger record.
func (lc *lifecycle) reject(code, message, status string, httpStatus int) {
	lc.errCode, lc.errMsg, lc.status, lc.httpStat = code, message, status, httpStatus
	e := normalize(code, message)
	lc.setResponseHeaders()
	lc.w.Header().Set("Content-Type", "application/json")
	lc.w.WriteHeader(e.Status)
	if lc.anthropic {
		// The /v1/messages surface answers in the Anthropic error envelope
		// (anthropic.go), so a rejection is parseable by an Anthropic client.
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"type": "error",
			"error": map[string]string{
				"type": anthropicErrorType(e.Code), "message": e.Message,
			},
		})
	} else {
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"error": map[string]string{"message": e.Message, "type": e.Type, "code": e.Code},
		})
	}
	// A rejected request is still a ledger row (spec §8: metadata always).
	lc.finish()
}

// setResponseHeaders stamps the PRD §90 identity headers, and the optional
// cost metadata behind its flag (default off).
func (lc *lifecycle) setResponseHeaders() {
	h := lc.w.Header()
	h.Set("x-fudrouter-request-id", lc.requestID)
	if lc.resolved != nil && len(lc.resolved.ModelSlugs) > 0 {
		h.Set("x-fudrouter-model", lc.servedModel())
	}
	if winner := lc.winner(); winner != nil && winner.Candidate != nil {
		h.Set("x-fudrouter-provider", winner.Candidate.Store.ProviderName)
	}
	h.Set("x-fudrouter-latency", fmt.Sprint(time.Since(lc.start).Milliseconds()))
	// Cost metadata is flag-gated (PRD §90, default off) and only stamped when
	// the usage to compute it from is already known: on a stream the headers go
	// out with the FIRST byte, long before the usage chunk arrives, so the
	// header is simply absent there (the value is still billed and recorded in
	// request_log).
	if lc.h.showCostMeta && lc.usageSeen {
		h.Set("x-fudrouter-cost-micro", fmt.Sprint(lc.customerCost()))
	}
}

// resolvePricing returns the spec §6 price snapshot — the pricing_rule version
// effective at REQUEST START (lc.start), frozen so a later price change never
// rewrites history — resolving it on first use and reusing the result.
//
// Lazy because the snapshot is needed in two places at different times: the
// cost header (only when usage is known, so after a non-stream response body is
// read) and buildRow (at ledger write). Resolved under a DETACHED context: the
// client may already be gone, and the snapshot must still land.
func (lc *lifecycle) resolvePricing() *store.Pricing {
	if lc.pricing != nil {
		return lc.pricing
	}
	w := lc.winner()
	if w == nil || w.Candidate == nil {
		return nil
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(lc.r.Context()), 5*time.Second)
	p, err := lc.h.store.ResolvePricing(pctx,
		w.Candidate.Store.ModelID, w.Candidate.Store.ProviderModelID, lc.start)
	cancel()
	if err != nil {
		return nil
	}
	lc.pricing = p
	return p
}
// customerCost is the charge the lifecycle computed (or would compute) in
// micro-units — the value request_log.cost carries. Only surfaced to the
// client behind the cost-headers flag (PRD §90).
func (lc *lifecycle) customerCost() int64 {
	p := lc.resolvePricing()
	if p == nil {
		return 0
	}
	in, cached, out, reason := p.BillablePrices()
	u := lc.usage
	c := cost.ComputeUsage(
		u.TokensIn-u.CachedInputTokens, u.CachedInputTokens,
		u.TokensOut-u.ReasoningTokens, u.ReasoningTokens,
		in, cached, out, reason)
	if c < 0 {
		return 0
	}
	return c
}

func (lc *lifecycle) servedModel() string {
	if w := lc.winner(); w != nil && w.Candidate != nil {
		return w.Candidate.Store.ModelSlug
	}
	if lc.resolved != nil && len(lc.resolved.ModelSlugs) > 0 {
		return lc.resolved.ModelSlugs[0]
	}
	return lc.requested
}

func (lc *lifecycle) winner() *routing.Attempt {
	for i := len(lc.attempts) - 1; i >= 0; i-- {
		if lc.attempts[i].ErrorCode == "" {
			return lc.attempts[i]
		}
	}
	return nil
}

// fail records a terminal failure and answers the client with the normalized
// envelope. `err` is raw upstream/transport text (recorded in the ledger only).
func (lc *lifecycle) fail(err error) {
	code := lc.errCode
	if code == "" {
		code = routing.ErrCodeUpstreamError
	}
	if len(lc.attempts) > 0 {
		last := lc.attempts[len(lc.attempts)-1]
		if last.ErrorCode != "" {
			code = last.ErrorCode
		}
		if last.RawMessage != "" {
			lc.rawErr = last.RawMessage
		}
	}
	if err != nil && lc.rawErr == "" {
		lc.rawErr = err.Error()
	}
	msg := lc.errMsg
	// The queue message is trusted only when the LAST attempt asked for a
	// client-visible status (the freebuff waiting room): an earlier attempt's
	// hint must not describe a later, different failure.
	if len(lc.attempts) == 0 || lc.attempts[len(lc.attempts)-1].ClientStatus == 0 {
		msg = ""
	}
	if msg == "" {
		msg = "upstream request failed"
	}
	lc.errCode, lc.errMsg = code, msg
	lc.status = statusForErrCode(code)
	lc.httpStat = statusCodeFor(code)

	e := normalize(code, msg)
	lc.setResponseHeaders()
	if len(lc.attempts) > 0 {
		last := lc.attempts[len(lc.attempts)-1]
		// A back-off hint can override the taxonomy default status (waiting
		// room: 503, not provider-unavailable's 502) and relays its
		// Retry-After seconds so the client knows when to come back.
		if last.ClientStatus != 0 {
			lc.httpStat = last.ClientStatus
		}
		if last.RetryAfterSeconds > 0 {
			lc.w.Header().Set("Retry-After", strconv.Itoa(last.RetryAfterSeconds))
		}
	}
	lc.w.Header().Set("Content-Type", "application/json")
	// httpStat carries the back-off override (or the taxonomy default), so it —
	// not e.Status — is what the client sees.
	status := lc.httpStat
	if status == 0 {
		status = e.Status
	}
	lc.w.WriteHeader(status)
	if lc.anthropic {
		// The /v1/messages surface answers in the Anthropic error envelope.
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"type": "error",
			"error": map[string]string{
				"type": anthropicErrorType(e.Code), "message": e.Message,
			},
		})
	} else {
		_ = json.NewEncoder(lc.w).Encode(map[string]any{
			"error": map[string]string{"message": e.Message, "type": e.Type, "code": e.Code},
		})
	}
	lc.finish()
}

// statusForErrCode maps the taxonomy onto the spec §8 status vocabulary.
func statusForErrCode(code string) string {
	switch code {
	case "":
		return "success"
	case routing.ErrCodeRateLimited:
		return "rate_limited"
	case routing.ErrCodeProviderTimeout:
		return "timeout"
	case routing.ErrCodeProviderUnavailable, routing.ErrCodeCircuitOpen, routing.ErrCodeUpstreamError:
		return "provider_error"
	case routing.ErrCodeInternalError:
		return "internal_error"
	case routing.ErrCodeAuthError, routing.ErrCodeAuthorization, routing.ErrCodeInvalidRequest,
		routing.ErrCodeModelNotFound, routing.ErrCodeContextTooLong, routing.ErrCodeUnsupportedParam,
		routing.ErrCodeContentRejected, routing.ErrCodeInsufficientCredits:
		return "client_error"
	}
	return "internal_error"
}

// upstreamContext bounds a non-streaming exchange end to end. A stream is
// governed by the client's own connection (r.Context()) plus the routing
// deadline for the ATTEMPT START only — a stream lives until the client
// disconnects, and an overall timeout would sever it mid-answer.
func (lc *lifecycle) upstreamContext(r *http.Request, stream bool) context.Context {
	if stream {
		return r.Context()
	}
	bound := nonStreamTimeout
	if d := time.Until(lc.deadline); !lc.deadline.IsZero() && d > 0 && d < bound {
		bound = d
	}
	ctx, cancel := context.WithTimeout(r.Context(), bound)
	// cancel runs when the response body is fully read or the handler returns;
	// the caller stores it on the lifecycle so the body read stays bounded.
	lc.cancelUpstream = cancel
	return ctx
}

// finish writes the ledger: request_log (with the usage_charge ledger row when
// there is a billing account, PRD §128) plus one request_attempt row per
// routing attempt (spec §8). It is the single funnel every outcome passes
// through — which is why one token clamp covers them all.
func (lc *lifecycle) finish() {
	if lc.finished {
		return
	}
	lc.finished = true

	// Release the concurrency slot first: it must not survive the request.
	if lc.admission != nil {
		lc.admission.Release()
	}
	if lc.cancelUpstream != nil {
		defer lc.cancelUpstream()
	}

	ctx, cancel := context.WithTimeout(context.WithoutCancel(lc.r.Context()), 5*time.Second)
	defer cancel()

	// Clamp at the funnel: the token counts come from the upstream's `usage`
	// block, which is untrusted. A negative count would make cost negative and
	// lower the month's total, walking a key past its cap.
	u := lc.usage
	u.TokensIn, u.CachedInputTokens, u.TokensOut, u.ReasoningTokens, u.TotalTokens =
		clampTokens(u.TokensIn), clampTokens(u.CachedInputTokens),
		clampTokens(u.TokensOut), clampTokens(u.ReasoningTokens), clampTokens(u.TotalTokens)

	row := lc.buildRow(u)
	if row.Cost > 0 && lc.key != nil {
		// The spend counters move with the charge so the next request's fast
		// path sees it (spec §7).
		defer lc.h.limiter.SpendAdd(ctx,
			&limits.APIKeyIdentity{KeyID: lc.key.ID, WorkspaceID: lc.key.WorkspaceID, Store: lc.h.store},
			row.Cost)
		defer lc.h.budgetSpendAdd(ctx, lc, row.Cost)
	}

	charge, err := lc.h.store.ChargeRequest(ctx, row)
	if err != nil {
		log.Printf("[proxy] charge failed for %s: %v", row.ID, err)
		// The ledger row is the priority: fall back to an insert that still
		// carries the credit_ledger entry, so a failed charge can never leave
		// balance_micro desynced from SUM(credit_ledger.amount_micro). Only if
		// THAT fails too is the request invisible.
		if err2 := lc.h.store.InsertRequestLogWithLedger(ctx, row); err2 != nil {
			log.Printf("[proxy] request_log insert failed: %v", err2)
		}
	}
	if charge != nil && (charge.Warning || charge.HardStop) {
		lc.h.raiseLowBalance(ctx, charge, row.WorkspaceID)
	}

	// Attempts come after the request row: request_attempt.request_id is an FK.
	for _, a := range lc.attempts {
		at := attemptRow(row.ID, a)
		if err := lc.h.store.InsertRequestAttempt(ctx, at); err != nil {
			log.Printf("[proxy] request_attempt insert failed: %v", err)
		}
	}
}

// buildRow assembles the spec §8 request_log row from the lifecycle state.
func (lc *lifecycle) buildRow(u usageCounts) *store.RequestLog {
	row := &store.RequestLog{
		ID:        lc.requestID,
		Endpoint:  lc.endpoint,
		Stream:    lc.stream,
		Attempts:  max(len(lc.attempts), 1),
		Timing:    lc.timing,
		Currency:  "USD",
		LatencyMs: time.Since(lc.start).Milliseconds(),
	}
	if lc.key != nil {
		row.UserID = lc.key.UserID
		row.APIKeyID = lc.key.ID
		row.WorkspaceID = lc.key.WorkspaceID
		row.ProjectID = lc.key.ProjectID
		row.EnvironmentID = lc.key.EnvironmentID
	}
	row.ClientIP = clientIP(lc.r)
	row.ClientDisconnected = lc.clientDisconnected
	row.RequestedModel = lc.requested
	row.RoutingPolicyID = lc.polID
	if lc.pol != nil {
		row.Strategy = lc.pol.Strategy
	}
	if lc.resolved != nil {
		row.ModelID = firstOf(lc.resolved.ModelIDs)
	}
	if w := lc.winner(); w != nil && w.Candidate != nil {
		row.ModelID = w.Candidate.Store.ModelID
		row.ProviderModelID = w.Candidate.Store.ProviderModelID
		row.ProviderID = w.Candidate.Store.ProviderID
		row.ConnectionID = w.Candidate.Store.ConnectionID
		if w.CredentialID != "" {
			row.CredentialID = w.CredentialID
		}
		if w.TTFTMs != nil {
			row.TTFTMs = w.TTFTMs
		}
		// spec §8 timing["connection"]: time to the upstream's response headers
		// on the winning exchange (body time is `generation`).
		lc.timing["connection"] = w.LatencyMs
	}
	if lc.streamTTFT != nil {
		row.TTFTMs = lc.streamTTFT
	}

	row.TokensIn, row.CachedInputTokens, row.TokensOut, row.ReasoningTokens = u.TokensIn, u.CachedInputTokens, u.TokensOut, u.ReasoningTokens
	if lc.usageSeen {
		total := u.TotalTokens
		if total == 0 {
			total = u.TokensIn + u.TokensOut
		}
		row.TotalTokens = &total
	}
	// total_tokens NULL = the provider did not report (PRD §122).

	// Price snapshot (spec §6): the version effective at request start, frozen
	// into the row so a later price change never rewrites history. Resolved
	// under the DETACHED context: the client may already be gone, and the
	// snapshot must still land.
	if p := lc.resolvePricing(); p != nil {
		row.PricingRuleID = p.RuleID
		if !p.Legacy {
			row.InputPriceMicro = strPtr(p.InputStr)
			row.OutputPriceMicro = strPtr(p.OutputStr)
			if p.CachedStr != "" {
				row.CachedInputPriceMicro = strPtr(p.CachedStr)
			}
			if p.ReasonStr != "" {
				row.ReasoningPriceMicro = strPtr(p.ReasonStr)
			}
		}
		in, cached, out, reason := p.BillablePrices()
		// Four token classes at their own price (spec §6 NULL fallbacks).
		row.Cost = cost.ComputeUsage(
			u.TokensIn-u.CachedInputTokens, u.CachedInputTokens,
			u.TokensOut-u.ReasoningTokens, u.ReasoningTokens,
			in, cached, out, reason)
		if row.Cost < 0 {
			row.Cost = 0
		}
		// No per-provider price list exists yet, so the provider cost is the
		// same number (0007's precedent: "a snapshot, not a lie").
		row.ProviderCostMicro = row.Cost
	}

	row.Status = lc.status
	if row.Status == "" {
		row.Status = "success"
	}
	if lc.clientDisconnected {
		row.Status = "cancelled"
	}
	row.ErrorCode = lc.errCode
	// Raw upstream text goes in `error`, never to the client (spec §8).
	row.Error = lc.rawErr
	if row.Error == "" {
		row.Error = lc.errMsg
	}
	if lc.httpStat != 0 {
		s := lc.httpStat
		row.HTTPStatus = &s
	}
	row.FallbackUsed = len(lc.attempts) > 1
	return row
}

// attemptRow maps one routing attempt onto its spec §8 request_attempt row.
func attemptRow(requestID string, a *routing.Attempt) *store.RequestAttempt {
	at := &store.RequestAttempt{
		ID:         ids.New("rta"),
		RequestID:  requestID,
		Attempt:    a.Attempt,
		Reason:     a.Reason,
		StartedAt:  a.StartedAt,
		FinishedAt: a.FinishedAt,
		LatencyMs:  a.LatencyMs,
		TTFTMs:     a.TTFTMs,
		Metadata:   map[string]any{},
	}
	if a.Candidate != nil && a.Candidate.Store != nil {
		at.ProviderID = a.Candidate.Store.ProviderID
		at.ConnectionID = a.Candidate.Store.ConnectionID
		at.ProviderModelID = a.Candidate.Store.ProviderModelID
		at.Metadata["upstream_model"] = a.Candidate.Store.UpstreamModel
		at.Metadata["model_slug"] = a.Candidate.Store.ModelSlug
	}
	if a.CredentialID != "" {
		at.CredentialID = a.CredentialID
	}
	if a.HTTPStatus != 0 {
		s := a.HTTPStatus
		at.HTTPStatus = &s
	}
	if a.ErrorCode != "" {
		at.ErrorCode = a.ErrorCode
	}
	retryable := a.Retryable
	at.Retryable = &retryable
	if a.RawMessage != "" {
		at.Metadata["upstream_error"] = truncate(a.RawMessage, 500)
	}
	return at
}

// serveBuffered relays a buffered upstream body and records the outcome.
func (lc *lifecycle) serveBuffered(w http.ResponseWriter, respBody []byte, hdr http.Header) {
	copyUpstreamHeaders(w, hdr)
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	lc.usage, lc.usageSeen = parseUsage(respBody)
	if lc.usageSeen {
		lc.errCode, lc.status = "", "success"
	} else {
		lc.status = "success"
	}
	lc.setResponseHeaders()
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBody)
	lc.finish()
}

// logTarget records the upstream status of the winning exchange's transport
// phase (kept separate from the attempt rows so a stream's status is known
// before its body ends).
func (lc *lifecycle) logTarget(status int) {
	if len(lc.attempts) == 0 {
		return
	}
	last := lc.attempts[len(lc.attempts)-1]
	if last.HTTPStatus == 0 {
		last.HTTPStatus = status
	}
}

// dispatch runs the routing walk for one request body against the connection
// network. `path` is the upstream path (chat/completions for the native
// endpoint, or the client's own /v1-stripped path for the generic one).
func (lc *lifecycle) dispatch(ctx context.Context, upBody []byte, method, rawQuery, upstreamPath string) (*http.Response, error) {
	if len(lc.cands) == 0 {
		// No model resolution (non-model endpoint): pick nothing to route.
		return nil, fmt.Errorf("no routable target")
	}

	attemptFn := func(attemptCtx context.Context, cand *routing.Candidate, next int) []*routing.Attempt {
		return lc.attempt(attemptCtx, cand, next, upBody, method, rawQuery, upstreamPath)
	}
	res := routing.Execute(ctx, lc.cands, *lc.pol, lc.deadline, lc.h.breaker, attemptFn)
	lc.attempts = res.Attempts

	if res.Winner != nil {
		if resp, ok := res.Winner.Payload.(*http.Response); ok {
			return resp, nil
		}
		return nil, fmt.Errorf("no response payload")
	}
	if len(res.Attempts) == 0 {
		return nil, fmt.Errorf("request deadline reached before any attempt could start")
	}
	return nil, fmt.Errorf("every candidate failed: %s", res.LastErrorCode)
}

// attempt is ONE candidate's exchange loop: it rotates the connection's
// credential rows (spec §4) and records every real upstream exchange as its own
// attempt (spec §8) until one succeeds, the attempt budget runs out, or the
// failure is request-shaped (spec §9). routing.Execute renumbers the rows and
// enforces the total budget; `n` is the loop's first attempt number.
func (lc *lifecycle) attempt(ctx context.Context, cand *routing.Candidate, n int, upBody []byte, method, rawQuery, upstreamPath string) []*routing.Attempt {
	var out []*routing.Attempt
	for range 8 {
		if err := ctx.Err(); err != nil {
			break
		}
		if lc.pol != nil && len(lc.attempts)+len(out) >= lc.pol.MaxAttempts {
			break
		}
		if !lc.deadline.IsZero() && time.Now().Add(estimateFor(cand)).After(lc.deadline) {
			break // spec §9: never start an attempt that cannot finish
		}
		a := lc.exchange(ctx, cand, n+len(out), upBody, method, rawQuery, upstreamPath)
		out = append(out, a)
		if a.ErrorCode == "" || !a.Retryable {
			break
		}
	}
	if len(out) == 0 {
		a := &routing.Attempt{Attempt: n, Candidate: cand, Reason: cand.Reason, StartedAt: time.Now()}
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderTimeout, true
		a.RawMessage = "request deadline reached before an attempt could start"
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		out = append(out, a)
	}
	return out
}

// estimateFor is the candidate's p95 latency estimate (ms) used by the attempt
// loop's deadline check — the same signal routing.Execute's budget check uses.
func estimateFor(cand *routing.Candidate) time.Duration {
	if cand == nil || cand.LatencyMs <= 0 {
		return 300 * time.Millisecond
	}
	return time.Duration(cand.LatencyMs) * time.Millisecond
}

// exchange performs ONE upstream exchange and classifies it (spec §9). The
// attempt it returns is one request_attempt row.
func (lc *lifecycle) exchange(ctx context.Context, cand *routing.Candidate, n int, upBody []byte, method, rawQuery, upstreamPath string) *routing.Attempt {
	a := &routing.Attempt{Attempt: n, Candidate: cand, Reason: cand.Reason, StartedAt: time.Now()}

	target := lc.h.targetFor(cand)
	if target == nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		return a
	}
	pickStart := time.Now()
	pickCtx, cancel := context.WithTimeout(ctx, pickBudget)
	picked, err := target.pool.Pick(pickCtx)
	cancel()
	// spec §8 timing["queue"]: time spent waiting for a usable upstream account.
	lc.timing["queue"] += time.Since(pickStart).Milliseconds()
	if err != nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.RawMessage = err.Error()
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		return a
	}

	a.CredentialID = picked.CredID

	if target.protocol == ProtocolFreebuff {
		resp, err := lc.h.freebuff.Chat(ctx, cand.Store.BaseURL, picked.Token, cand.Store.UpstreamModel, upBody)
		a.FinishedAt = time.Now()
		a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
		if err != nil {
			var pe *freebuff.Error
			if errors.As(err, &pe) {
				a.ErrorCode = statusForKind(pe.Kind)
				a.Retryable = retryableFreebuff(pe.Kind)
				a.HTTPStatus = statusForFreebuff(pe.Kind)
				a.RawMessage = pe.Msg
				// The waiting room is an OPERATIONAL hint, not an outage: the
				// client gets 503 + Retry-After + the queue position (pinned by
				// TestFreebuffWaitingRoomReturns503), never a generic 502. The
				// rate limit keeps its taxonomy 429 but still relays the
				// back-off hint. Only the waiting-room message is safe to show:
				// manager.go composes it from session metadata, while a rate
				// limit's pe.Msg is raw upstream text (spec §8 keeps that in
				// request_log.error only).
				if pe.Kind == freebuff.KindWaitingRoom {
					a.ClientStatus = http.StatusServiceUnavailable
					a.RetryAfterSeconds = pe.RetryAfter
					lc.errMsg = pe.Msg
				} else if pe.Kind == freebuff.KindRateLimit {
					a.RetryAfterSeconds = pe.RetryAfter
				}
				if retryableFreebuff(pe.Kind) {
					// The waiting room is a PROVIDER-wide back-off: the queue
					// is not this account's fault, and parking it makes the
					// follow-up attempt fail at credential pick — the client
					// then loses the queue hint to a "no usable credential"
					// error. Everything else in the retryable set is
					// account-shaped (auth, rate limit) and IS parked.
					if pe.Kind != freebuff.KindWaitingRoom {
						target.pool.MarkFailed(picked.Token)
						lc.h.parkCredential(a.CredentialID, "rate_limited")
					}
				}
				return a
			}
			a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
			a.RawMessage = err.Error()
			return a
		}
		a.HTTPStatus = resp.StatusCode
		a.Payload = resp
		return a
	}

	// The upstream must see the provider's OWN model id, never the name the
	// client asked for: a virtual (`fudrouter/auto`) or an alias resolves to a
	// concrete canonical model, and even a canonical slug can be served under a
	// different upstream id (provider_model.provider_model_id). Sending the
	// client's string verbatim made every virtual fail upstream with "model not
	// found" while the same slug called directly worked.
	upBody = rewriteModelField(upBody, cand.Store.UpstreamModel)

	upURL := strings.TrimRight(cand.Store.BaseURL, "/") + upstreamPath
	if rawQuery != "" {
		upURL += "?" + rawQuery
	}
	reqCtx := ctx
	if lc.cancelUpstream == nil && !lc.stream {
		var cancelReq context.CancelFunc
		reqCtx, cancelReq = context.WithTimeout(ctx, nonStreamTimeout)
		defer cancelReq()
	}
	upReq, err := http.NewRequestWithContext(reqCtx, method, upURL, bytes.NewReader(upBody))
	if err != nil {
		a.ErrorCode, a.Retryable = routing.ErrCodeInternalError, false
		a.RawMessage = err.Error()
		return a
	}
	ct := lc.r.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	upReq.Header.Set("Content-Type", ct)
	upReq.Header.Set("Authorization", "Bearer "+picked.Token)
	for k, v := range target.defaultHeaders {
		if reservedHeaders[strings.ToLower(k)] {
			continue
		}
		upReq.Header.Set(k, v)
	}

	resp, err := lc.h.client.Do(upReq)
	a.FinishedAt = time.Now()
	a.LatencyMs = a.FinishedAt.Sub(a.StartedAt).Milliseconds()
	if err != nil {
		a.Transport = err
		a.ErrorCode, a.Retryable = routing.ErrCodeProviderUnavailable, true
		a.RawMessage = err.Error()
		return a
	}
	a.HTTPStatus = resp.StatusCode
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		a.Payload = resp
		return a
	}

	// Non-2xx: capture the body for the record (and the client message), then
	// classify per spec §9.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	code, retryable := routing.ClassifyUpstream(resp.StatusCode)
	a.ErrorCode, a.Retryable = code, retryable
	a.RawMessage = upstreamMessage(body)
	if retryable {
		// A rejected credential is parked so the next request picks another
		// (S0 behaviour, spec §5 credential state).
		target.pool.MarkFailed(picked.Token)
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			lc.h.parkCredential(a.CredentialID, "auth_failed")
		} else if resp.StatusCode == 429 {
			lc.h.parkCredential(a.CredentialID, "rate_limited")
		}
	} else {
		a.Payload = &errorBody{status: resp.StatusCode, body: body}
	}
	return a
}

// rewriteModelField returns body with its top-level "model" set to name. It is
// how a resolved candidate's upstream id reaches the provider. Bodies that are
// not JSON objects, or that carry no "model" key, pass through untouched, so a
// non-model endpoint is never rewritten.
func rewriteModelField(body []byte, name string) []byte {
	if name == "" {
		return body
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	if _, ok := m["model"]; !ok {
		return body
	}
	enc, err := json.Marshal(name)
	if err != nil {
		return body
	}
	m["model"] = enc
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// errorBody carries a non-retryable upstream failure's body so the client can
// still see the provider's own message inside the normalized envelope.
type errorBody struct {
	status int
	body   []byte
}

func statusForFreebuff(k freebuff.ErrorKind) int {
	switch k {
	case freebuff.KindAuthExpired:
		return 401
	case freebuff.KindModelUnavailable:
		return 404
	case freebuff.KindRateLimit:
		return 429
	case freebuff.KindBadRequest:
		return 400
	case freebuff.KindWaitingRoom:
		// Operational, not broken: come back later (Retry-After relays when).
		return 503
	default:
		return 502
	}
}

// upstreamMessage extracts the provider's own error message from a body, for
// the client-facing message (never the CODE — spec §8).
func upstreamMessage(body []byte) string {
	var parsed struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != nil {
		switch e := parsed.Error.(type) {
		case string:
			return truncate(e, 200)
		case map[string]any:
			if m, ok := e["message"].(string); ok {
				return truncate(m, 200)
			}
		}
	}
	return truncate(strings.TrimSpace(string(body)), 200)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func firstOf(ss []string) string {
	if len(ss) > 0 {
		return ss[0]
	}
	return ""
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
