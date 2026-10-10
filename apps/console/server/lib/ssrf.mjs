// Upstream SSRF guard + provider catalog probe. Extracted verbatim from
// server/admin.mjs; needs node:net, node:dns and the credential helpers.
import net from 'node:net';
import { lookup as _dnsLookup } from 'node:dns/promises';
import { _headersFor, _tokenAt } from './credentials.mjs';
import { isBlockedIp } from './ip.mjs';

// Hostname/IP literal that must never be called as an upstream. Covers the full
// IANA special-use set (see lib/ip.mjs) plus intranet TLDs — the old version only
// listed 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16 and ::1/fc/fd/fe80, so
// CGNAT (100.64/10, i.e. Tailscale), 192.0.0/24, 198.18/15, multicast, reserved
// and every IPv4-mapped IPv6 form (::ffff:127.0.0.1) sailed through.
export function _isBlockedLiteral(host) {
	const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (!h) return true;
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
	const bare = h.includes('%') ? h.slice(0, h.indexOf('%')) : h;
	if (net.isIP(bare)) return isBlockedIp(bare);
	return false;
}

export async function _assertPublic(rawUrl, allowPrivate = false) {
	if (allowPrivate) return { ok: true };
	let u;
	try {
		u = new URL(String(rawUrl));
	} catch {
		return { ok: false, reason: 'base_url is not a valid URL' };
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') {
		return { ok: false, reason: `scheme ${u.protocol} is not allowed; use http or https` };
	}
	const host = u.hostname;
	if (!host) return { ok: false, reason: 'base_url has no host' };
	if (_isBlockedLiteral(host)) return { ok: false, reason: `refusing to call a non-public address (${host})` };
	// Resolve EVERY record, not just the first: a name with several A/AAAA records
	// (or one answering differently per query) must not slip a private address in.
	let addrs;
	try {
		addrs = await _dnsLookup(host, { all: true, verbatim: true });
	} catch {
		return { ok: false, reason: `cannot resolve upstream host (${host})` };
	}
	if (!addrs || !addrs.length) return { ok: false, reason: `cannot resolve upstream host (${host})` };
	for (const r of addrs) {
		if (_isBlockedLiteral(r.address)) {
			return { ok: false, reason: `refusing to call a non-public address (${host} -> ${r.address})` };
		}
	}
	return { ok: true };
}

export async function _fetchCatalog(baseUrl, cred, index = 0) { const base = String(baseUrl).trim().replace(/\/+$/, ''); const headers = _headersFor(cred, _tokenAt(cred, index)); const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000); try { const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal, redirect: 'manual' }); const rl = {}; for (const [k, v] of res.headers.entries()) { if (k.startsWith('x-ratelimit') || k === 'retry-after') rl[k] = v; } if (!res.ok) return { models: [], status: res.status, url: `${base}/models`, rateLimit: rl }; let payload = null; try { payload = await res.json(); } catch { payload = null; } const raw = payload?.data && Array.isArray(payload.data) ? payload.data : (Array.isArray(payload) ? payload : []); const seen = new Set(); const models = []; for (const item of raw) { if (!item || typeof item !== 'object') continue; const slug = String(item.id ?? item.model ?? item.slug ?? '').trim(); if (!slug || seen.has(slug)) continue; seen.add(slug); models.push({ slug, name: String(item.name ?? item.display_name ?? item.label ?? slug) }); } return { models, status: res.status, url: `${base}/models`, rateLimit: rl }; } finally { clearTimeout(t); } }
export const _isIpOrCidr = (value) => { const v = String(value).trim(); if (!v || v.length > 64) return false; const slash = v.indexOf('/'); if (slash === -1) return net.isIP(v) !== 0; if (v.indexOf('/', slash + 1) !== -1) return false; const addr = v.slice(0, slash); const prefix = v.slice(slash + 1); if (!/^(0|[1-9]\d?)$/.test(prefix)) return false; if (net.isIPv4(addr)) return Number(prefix) <= 32; if (net.isIPv6(addr)) return Number(prefix) <= 128; return false; };
