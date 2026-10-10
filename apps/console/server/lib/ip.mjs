// Shared IP handling: literal classification (SSRF guard) and real client-IP
// extraction behind the trusted proxy chain. Consolidated here because the
// X-Forwarded-For logic was copy-pasted into index/admin/pages/playground and
// the blocklist lived only in ssrf.mjs — both had drifted and were bypassable.
import net from 'node:net';

// ---------------------------------------------------------------- IPv4 ----
export function _ipv4ToBig(ip) {
	const o = String(ip).split('.');
	if (o.length !== 4) return null;
	let n = 0n;
	for (const part of o) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const v = Number(part);
		if (v > 255) return null;
		n = (n << 8n) | BigInt(v);
	}
	return n;
}

// Ranges that must never be reachable through a user-supplied upstream URL.
export function _ipv4BlockedBig(n) {
	const a = Number((n >> 24n) & 0xffn);
	const b = Number((n >> 16n) & 0xffn);
	const c = Number((n >> 8n) & 0xffn);
	if (a === 0) return true;                                       // 0.0.0.0/8 "this network"
	if (a === 10) return true;                                      // RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true;              // 100.64/10 CGNAT (Tailscale!)
	if (a === 127) return true;                                     // loopback
	if (a === 169 && b === 254) return true;                        // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true;               // RFC1918
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;  // 192.0.0/24, TEST-NET-1
	if (a === 192 && b === 88 && c === 99) return true;             // 6to4 relay anycast
	if (a === 192 && b === 168) return true;                        // RFC1918
	if (a === 198 && (b === 18 || b === 19)) return true;           // 198.18/15 benchmarking
	if (a === 198 && b === 51 && c === 100) return true;            // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true;             // TEST-NET-3
	if (a >= 224) return true;                                      // multicast 224/4 + reserved 240/4 + broadcast
	return false;
}

// ---------------------------------------------------------------- IPv6 ----
// Parse to a 128-bit BigInt (null when malformed). Handles "::", a dotted IPv4
// tail ("::ffff:1.2.3.4") and a "%zone" suffix.
export function _parseV6(raw) {
	let s = String(raw ?? '').trim().toLowerCase();
	if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
	const pct = s.indexOf('%');
	if (pct !== -1) s = s.slice(0, pct);
	let v4 = null;
	const mm = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mm) {
		const o = mm[1].split('.').map(Number);
		if (o.some((x) => x > 255)) return null;
		v4 = o;
		s = s.slice(0, mm.index);
		if (s.endsWith(':')) s = s.slice(0, -1);
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const groups = [];
	for (const g of head) groups.push(g);
	const fill = 8 - head.length - tail.length - (v4 ? 2 : 0);
	if (halves.length === 2) {
		if (fill < 0) return null;
		for (let i = 0; i < fill; i++) groups.push('0');
	} else if (fill !== 0) return null;
	for (const g of tail) groups.push(g);
	if (v4) {
		groups.push(((v4[0] << 8) | v4[1]).toString(16));
		groups.push(((v4[2] << 8) | v4[3]).toString(16));
	}
	if (groups.length !== 8) return null;
	let n = 0n;
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		n = (n << 16n) | BigInt(parseInt(g, 16));
	}
	return n;
}

const _V6_BLOCKS = [
	[_parseV6('fc00::'), 7],      // unique-local
	[_parseV6('fe80::'), 10],     // link-local
	[_parseV6('ff00::'), 8],      // multicast
	[_parseV6('2001:db8::'), 32], // documentation
	[_parseV6('2001::'), 32],     // Teredo
	[_parseV6('2002::'), 16],     // 6to4
	[_parseV6('64:ff9b::'), 96],  // NAT64 well-known prefix
	[_parseV6('100::'), 64]       // discard-only
];

export function _ipv6BlockedBig(n) {
	if (n >> 32n === 0n) return true;                                     // ::/96 unspecified/loopback/v4-compat
	if ((n >> 32n) === 0xffffn) return _ipv4BlockedBig(n & 0xffffffffn);  // IPv4-mapped ::ffff:a.b.c.d
	for (const [net_, bits] of _V6_BLOCKS) {
		if (net_ === null) continue;
		const shift = BigInt(128 - bits);
		if ((n >> shift) === (net_ >> shift)) return true;
	}
	return false;
}

// True when `addr` is an IP literal in a range we refuse to reach. Non-literal
// input (a hostname) returns false — the DNS check in _assertPublic covers it.
export function isBlockedIp(addr) {
	const h = String(addr ?? '').trim().toLowerCase();
	if (!h) return true;
	if (net.isIPv4(h)) {
		const n = _ipv4ToBig(h);
		return n === null ? true : _ipv4BlockedBig(n);
	}
	if (net.isIPv6(h)) {
		const n = _parseV6(h);
		return n === null ? true : _ipv6BlockedBig(n);
	}
	return false;
}

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
