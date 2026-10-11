// Billing — the single funnel every request's cost passes through.
//
// The router does not count tokens itself; it bills whatever the upstream
// reports in its `usage` block (PRD §87), so this file is also the trust
// boundary: `clampTokens` is what stops a hostile or buggy upstream from
// reporting a negative count and *lowering* a key's month-to-date spend past
// its caps.
//
// Every path funnels through lifecycle.buildRow/finish — chat buffered, chat
// streamed, generic buffered, and every error outcome — which is the only
// reason one clamp can cover them all.
package proxy

// maxTokensPerRequest bounds the token counts the router will bill from an
// upstream's reported usage. The router does not count tokens itself — it
// trusts the upstream's `usage` block — so a hostile or buggy upstream can
// report a negative count, which makes cost negative and *lowers* the month's
// accumulated spend, letting a key walk past its monthly_spend_micro cap. The
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
