// Client-IP handling for the request path: real client IP behind the trusted
// proxy chain, and trusted-proxy matching.
//
// The literal CLASSIFICATION does not live here any more. `isBlockedIp` and the
// range arithmetic moved into packages/platform/server/ssrf.ts, because that is
// the rule the SSRF guard applies to a provider base_url, to the worker's
// connection probes and to webhook delivery alike -- one rule, one home. It is
// re-exported below under the names this module has always used.
//
// Why it moved: this file held the hardened list while the LIVE guard used a
// shorter one, so the hardening was write-only. 23 addresses passed the live
// path and are refused here, `64:ff9b::a9fe:a9fe` (NAT64 of the cloud metadata
// address) and `2002:7f00:1::` (6to4 of loopback) among them. Nothing on the
// live path called this module's copy, which is exactly how that happens.
import net from 'node:net';
import { _ipv4ToBig } from './platform-ts.mjs';

export { isBlockedIp, _ipv4ToBig, _parseV6, _ipv4BlockedBig, _ipv6BlockedBig } from './platform-ts.mjs';

// ------------------------------------------------------- trusted proxy ----
// Peers we trust to have set X-Forwarded-For. On this box the request path is
// cloudflared -> caddy (:80, loopback) -> this server (:3002, loopback), so the
// socket peer is always loopback. Override with ROUTER_TRUSTED_PROXIES
// (comma-separated IPs and/or IPv4 CIDRs).
const TRUSTED_PROXIES = (process.env.ROUTER_TRUSTED_PROXIES || '127.0.0.1,::1')
	.split(',').map((s) => s.trim()).filter(Boolean);

function _ipv4CidrHit(ip, cidr) {
	const [base, bitsRaw] = String(cidr).split('/');
	const bits = Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const a = _ipv4ToBig(ip);
	const b = _ipv4ToBig(base);
	if (a === null || b === null) return false;
	if (bits === 0) return true;
	const mask = ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - bits)) - 1n);
	return (a & mask) === (b & mask);
}

export function _normalizeIp(addr) {
	if (addr === undefined || addr === null) return null;
	let a = String(addr).trim().toLowerCase();
	if (!a) return null;
	if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
	const pct = a.indexOf('%');
	if (pct !== -1) a = a.slice(0, pct);
	const m = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (m) a = m[1];
	return a || null;
}

export function isTrustedProxy(addr) {
	const ip = _normalizeIp(addr);
	if (!ip) return false;
	for (const t of TRUSTED_PROXIES) {
		if (t.includes('/')) {
			const tn = _normalizeIp(t.split('/')[0]);
			if (tn && net.isIPv4(ip) && _ipv4CidrHit(ip, t)) return true;
		} else if (_normalizeIp(t) === ip) {
			return true;
		}
	}
	return false;
}

// Real client IP. Every hop APPENDS to X-Forwarded-For, so a value an attacker
// sends ends up on the LEFT; walking right-to-left and stopping at the first
// untrusted entry yields the address the last trusted proxy actually saw. The
// header is ignored entirely unless the socket peer is a trusted proxy, so a
// direct/LAN caller cannot spoof it either.
export function clientIp(req) {
	const sock = _normalizeIp(req?.socket?.remoteAddress);
	if (!isTrustedProxy(sock)) return sock ?? null;
	const raw = req?.headers?.['x-forwarded-for'];
	if (!raw) return sock ?? null;
	const parts = (Array.isArray(raw) ? raw.join(',') : String(raw))
		.split(',').map((s) => s.trim()).filter(Boolean);
	for (let i = parts.length - 1; i >= 0; i--) {
		const ip = _normalizeIp(parts[i]);
		if (!ip) continue;
		if (!isTrustedProxy(ip)) return ip;
	}
	return sock ?? null;
}
