// Provider catalog probe: fetch `<baseUrl>/models` and shape the result.
//
// This file used to export its own _isBlockedLiteral/_assertPublic/_isIpOrCidr
// as well. Nothing called them: admin.mjs takes the guard from ./platform-ts.mjs
// and the validator from ./validate.mjs, so the local copies were dead code that
// made the guard look duplicated. They are gone; the guard is the platform's.
//
// Callers MUST run the guard before calling this -- admin.mjs does, at all six
// call sites. Folding the fetch itself into the shared guardedUpstreamFetch
// would make that impossible to forget and is the next step for this file, but
// _fetchCatalog has no test coverage today, so this pass changes no behaviour
// here. `redirect: 'manual'` is not optional: a redirect is a second request to
// an address nothing has checked.
import { _headersFor, _tokenAt } from './platform-ts.mjs';

export async function _fetchCatalog(baseUrl, cred, index = 0) { const base = String(baseUrl).trim().replace(/\/+$/, ''); const headers = _headersFor(cred, _tokenAt(cred, index)); const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000); try { const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal, redirect: 'manual' }); const rl = {}; for (const [k, v] of res.headers.entries()) { if (k.startsWith('x-ratelimit') || k === 'retry-after') rl[k] = v; } if (!res.ok) return { models: [], status: res.status, url: `${base}/models`, rateLimit: rl }; let payload = null; try { payload = await res.json(); } catch { payload = null; } const raw = payload?.data && Array.isArray(payload.data) ? payload.data : (Array.isArray(payload) ? payload : []); const seen = new Set(); const models = []; for (const item of raw) { if (!item || typeof item !== 'object') continue; const slug = String(item.id ?? item.model ?? item.slug ?? '').trim(); if (!slug || seen.has(slug)) continue; seen.add(slug); models.push({ slug, name: String(item.name ?? item.display_name ?? item.label ?? slug) }); } return { models, status: res.status, url: `${base}/models`, rateLimit: rl }; } finally { clearTimeout(t); } }
