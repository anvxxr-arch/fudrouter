/**
 * Fixed-window rate limiting for the credential form actions.
 *
 * Why this exists instead of reusing better-auth's limiter:
 *
 *  1. better-auth's limiter only runs inside its HTTP router
 *     (`onRequestRateLimit`, `dist/api/index.mjs:172`). The `/login` and
 *     `/signup` form actions call `auth.api.*` directly, so they never pass
 *     through it — measured live, eight consecutive POSTs to `/login` all
 *     returned 200 with no 429.
 *  2. Its key is built from `x-forwarded-for` alone, and with no
 *     `trustedProxies` configured it resolves only a single-address header.
 *     Behind this deployment's tunnel → Caddy → app chain that is the proxy
 *     address for every client, so the bucket is global rather than
 *     per-attacker: one abuser could exhaust it and lock out every login.
 *
 * The design here consumes two keys per attempt — the client address and the
 * submitted identity. The identity key is the load-bearing one: it holds even
 * when the address is untrustworthy (a spoofable forwarding header, a shared
 * NAT, or no header at all), because the thing an attacker actually has to vary
 * is the account, not the address.
 *
 * Counters are per-process and in-memory, matching better-auth's own default
 * backend. That is deliberate: the router is a single PM2 process, and an
 * in-process counter cannot be bypassed by racing a shared store. It resets on
 * restart, which is acceptable for credential-stuffing protection — the window
 * is minutes, not days.
 */

export interface LimitDecision {
	allowed: boolean;
	/** Milliseconds until the window resets. 0 when allowed. */
	retryAfterMs: number;
}

interface Window {
	count: number;
	resetAt: number;
}

export interface LimitRule {
	max: number;
	windowMs: number;
}

/** Ten attempts per address per fifteen minutes. Generous for a human. */
export const LOGIN_PER_ADDRESS: LimitRule = { max: 10, windowMs: 15 * 60_000 };

/** Five attempts per account per fifteen minutes — the brute-force ceiling. */
export const LOGIN_PER_IDENTITY: LimitRule = { max: 5, windowMs: 15 * 60_000 };

/** Five signups per address per hour. Signing up is rare; farming is not. */
export const SIGNUP_PER_ADDRESS: LimitRule = { max: 5, windowMs: 60 * 60_000 };

const windows = new Map<string, Window>();

/**
 * Hard cap on tracked keys so a flood of distinct keys cannot grow the map
 * without bound. Evicting a live window only makes the limiter more permissive
 * for that key, never less — it can never deny a legitimate attempt.
 */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Consume one unit against `key`. Pure with respect to `now`, so tests can
 * advance time without sleeping.
 */
export function consume(key: string, rule: LimitRule, now = Date.now()): LimitDecision {
	const existing = windows.get(key);

	if (!existing || now >= existing.resetAt) {
		if (windows.size >= MAX_TRACKED_KEYS) prune(now);
		windows.set(key, { count: 1, resetAt: now + rule.windowMs });
		return { allowed: true, retryAfterMs: 0 };
	}

	if (existing.count >= rule.max) {
		return { allowed: false, retryAfterMs: existing.resetAt - now };
	}

	existing.count += 1;
	return { allowed: true, retryAfterMs: 0 };
}

function prune(now: number): void {
	for (const [key, w] of windows) {
		if (now >= w.resetAt) windows.delete(key);
	}
	// Still at the cap because every window is live: drop oldest-inserted keys.
	while (windows.size >= MAX_TRACKED_KEYS) {
		const oldest = windows.keys().next();
		if (oldest.done) break;
		windows.delete(oldest.value);
	}
}

/** Test seam: forget every counter. */
export function resetRateLimits(): void {
	windows.clear();
}

/**
 * Best-effort client address.
 *
 * `cf-connecting-ip` is preferred because Cloudflare's edge sets it and
 * cloudflared is the only thing that reaches Caddy in this deployment. The
 * left-most `x-forwarded-for` entry is the fallback.
 *
 * This value is NOT a security boundary — a client that can reach the origin
 * directly, or a proxy that does not overwrite these headers, can forge it.
 * That is precisely why the identity limit exists alongside it.
 */
export function clientAddress(headers: Headers): string | null {
	const cf = headers.get('cf-connecting-ip');
	if (cf && cf.trim()) return cf.trim();
	const xff = headers.get('x-forwarded-for');
	if (xff) {
		const first = xff.split(',')[0]?.trim();
		if (first) return first;
	}
	return null;
}

/**
 * Consume one credential attempt for `scope`. Returns the first refusal; a
 * permitted attempt consumes both the address and the identity budget.
 */
export function limitCredentialAttempt(
	scope: 'login' | 'signup',
	headers: Headers,
	identity: string
): LimitDecision {
	const address = clientAddress(headers);
	if (address) {
		const rule = scope === 'login' ? LOGIN_PER_ADDRESS : SIGNUP_PER_ADDRESS;
		const decision = consume(`${scope}:addr:${address}`, rule);
		if (!decision.allowed) return decision;
	}

	// Signup has no meaningful identity to limit on: every attempt names a new
	// address by definition, so a per-email cap would never trigger.
	if (scope === 'login' && identity) {
		const decision = consume(
			`${scope}:id:${identity.toLowerCase()}`,
			LOGIN_PER_IDENTITY
		);
		if (!decision.allowed) return decision;
	}

	return { allowed: true, retryAfterMs: 0 };
}

/** Human-readable retry hint for a failure message. */
export function formatRetryAfter(retryAfterMs: number): string {
	const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
	if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
