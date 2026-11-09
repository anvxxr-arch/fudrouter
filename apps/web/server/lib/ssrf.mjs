// Provider catalog probe: fetch `<baseUrl>/models` and shape the result.
//
// This file used to export its own _isBlockedLiteral/_assertPublic/_isIpOrCidr
// as well. Nothing called them: admin.mjs takes the guard from ./platform-ts.mjs
// and the validator from ./validate.mjs, so the local copies were dead code that
// made the guard look duplicated. They are gone; the guard is the platform's.
//
// The fetch itself now folds into the shared `guardedUpstreamFetch` (platform
// ssrf.ts). That is the same pinned, DNS-rebind-safe fetch the rest of the
// router uses: the string pushed to `guardedUpstreamFetch` is the EXACT string
// it dials (compose-first, pin-validated-IPs), so `_fetchCatalog` can no longer
// resolve `baseUrl` in a guard and then have the later `fetch()` resolve a
// different, rebound address. Callers may still pre-flight with `_assertPublic`
// for a fast deny, but that is no longer load-bearing: the pinned fetch is the
// real check. `redirect: 'manual'` stays non-optional (a redirect would be a
// second request to an address nothing has checked).
import { _headersFor, _tokenAt, guardedUpstreamFetch } from './platform-ts.mjs';

export async function _fetchCatalog(baseUrl, cred, index = 0, allowPrivate = false) {
	const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
	const res = await guardedUpstreamFetch(base, allowPrivate, '/models', {
		headers: _headersFor(cred, _tokenAt(cred, index)),
		timeoutMs: 15000
	});
	if (!res.ok) {
		// Guard/fetch failure surfaces as an empty catalog with the reason; the
		// caller treats a failed probe like a non-200 upstream, never as success.
		return { models: [], status: 0, url: `${base}/models`, rateLimit: {}, error: res.message };
	}
	const rl = {};
	for (const [k, v] of res.response.headers.entries()) {
		if (k.startsWith('x-ratelimit') || k === 'retry-after') rl[k] = v;
	}
	if (!res.response.ok) {
		return { models: [], status: res.response.status, url: `${base}/models`, rateLimit: rl };
	}
	let payload = null;
	try { payload = await res.response.json(); } catch { payload = null; }
	const raw = payload?.data && Array.isArray(payload.data) ? payload.data : (Array.isArray(payload) ? payload : []);
	const seen = new Set();
	const models = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const slug = String(item.id ?? item.model ?? item.slug ?? '').trim();
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);
		models.push({ slug, name: String(item.name ?? item.display_name ?? item.label ?? slug) });
	}
	return { models, status: res.response.status, url: `${base}/models`, rateLimit: rl };
}
