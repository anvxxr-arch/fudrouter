import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for admin-initiated requests to a provider's base_url.
 *
 * The router already refuses to dial loopback/RFC1918/link-local/CGNAT
 * (backend/go/internal/proxy/guard.go, enforced at the socket via
 * net.Dialer.Control). This is the same rule for the web side, which fetches
 * with the global fetch and therefore has no dial hook to hang the check on.
 *
 * An `admin.ops` user can set a provider's base_url. Without this, that is a
 * request-forgery primitive: point it at 169.254.169.254 and the app reads the
 * cloud instance's credentials, or at 127.0.0.1:5432 and it becomes a port
 * scanner against everything listening on the box.
 */

/**
 * Whether `host` is a non-public literal address, blockable before any DNS work.
 *
 * A literal cannot be laundered through a DNS rebind, which is why this runs
 * before any resolution: it is the only check that applies whatever the host
 * turns out to resolve to.
 *
 * The rule is the full IANA special-use set, and it is deliberately the STRICT
 * one. Two shorter lists preceded it -- this module carried
 * 10/8,127/8,172.16/12,192.168/16,169.254/16,CGNAT,198.18/15 and ::1/fc/fd/fe80,
 * and `./admin-limits` carried an even weaker one -- while the console kept a
 * complete copy that nothing on the live path called. A differential run over 79
 * addresses found 23 that the long list refuses and the short one accepted, and
 * they are not academic:
 *
 *   64:ff9b::a9fe:a9fe   NAT64 of 169.254.169.254 -- cloud metadata
 *   64:ff9b::7f00:1      NAT64 of 127.0.0.1
 *   2002:7f00:1::        6to4 of 127.0.0.1
 *   2002:c0a8:101::      6to4 of 192.168.1.1
 *   ::0.0.0.1            IPv4-compatible loopback in the v6 space
 *   224/4, 240/4, 255.255.255.255, 0/8, 192.0.0/24, 192.0.2/24,
 *   192.88.99/24, 198.51.100/24, 203.0.113/24, Teredo, 2001:db8::/32, 100::/64
 *
 * On a host with NAT64/DNS64 (an IPv6-only or mobile network) the first of those
 * dials the metadata service through a check that had called it public. This
 * guard is what `guardedUpstreamFetch` applies to a provider base_url, to the
 * worker's connection probes AND to webhook delivery, so the hole was reachable
 * from every user-configurable URL, not just the admin console.
 *
 * Every range below is pinned by a case in apps/web/server/lib/ip.test.mjs.
 */
export function isBlockedLiteral(host: string): boolean {
	const ip = literalOrNull(host);
	if (!ip) return false;
	return isBlockedIp(ip);
}

/** Strip a URL-ish wrapper and a `%zone`, then return the bare literal or null. */
function literalOrNull(host: string): string | null {
	let h = String(host ?? '').trim().toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	const zone = h.indexOf('%');
	if (zone !== -1) h = h.slice(0, zone);
	return isIP(h) ? h : null;
}

/**
 * The blocklist proper, over a bare literal. Non-literals return false: a
 * hostname is the DNS check's business, not this one's.
 *
 * Written as arithmetic over the 32/128-bit value rather than string prefixes,
 * because the text form has spellings a prefix cannot see: `[::ffff:127.0.0.1]`
 * reaches here as `::ffff:7f00:1` once a URL parser has run, and 6to4/NAT64
 * carry the address they will actually connect to in their own bits.
 */
export function isBlockedIp(addr: string): boolean {
	const h = String(addr ?? '').trim().toLowerCase();
	if (!h) return true;
	if (isIP(h) === 4) {
		const n = ipv4ToBig(h);
		return n === null ? true : ipv4BlockedBig(n);
	}
	if (isIP(h) === 6) {
		const n = parseV6(h);
		return n === null ? true : ipv6BlockedBig(n);
	}
	return false;
}

export function ipv4ToBig(ip: string): bigint | null {
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

/** Ranges no user-supplied URL may reach. */
export function ipv4BlockedBig(n: bigint): boolean {
	const a = Number((n >> 24n) & 0xffn);
	const b = Number((n >> 16n) & 0xffn);
	const c = Number((n >> 8n) & 0xffn);
	if (a === 0) return true; // 0.0.0.0/8 "this network"
	if (a === 10) return true; // RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale)
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, TEST-NET-1
	if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
	return false;
}

/**
 * Parse to a 128-bit value, or null when malformed. Handles "::", a dotted IPv4
 * tail ("::ffff:1.2.3.4") and a "%zone" suffix.
 */
export function parseV6(raw: string): bigint | null {
	let s = String(raw ?? '').trim().toLowerCase();
	if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
	const pct = s.indexOf('%');
	if (pct !== -1) s = s.slice(0, pct);
	let v4: number[] | null = null;
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
	const groups: string[] = [];
	for (const g of head) groups.push(g);
	const fill = 8 - head.length - tail.length - (v4 ? 2 : 0);
	if (halves.length === 2) {
		if (fill < 0) return null;
		for (let i = 0; i < fill; i++) groups.push('0');
	} else if (fill !== 0) return null;
	for (const g of tail) groups.push(g);
	if (v4) {
		groups.push((((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16));
		groups.push((((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16));
	}
	if (groups.length !== 8) return null;
	let n = 0n;
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		n = (n << 16n) | BigInt(parseInt(g, 16));
	}
	return n;
}

const V6_BLOCKS: Array<[bigint | null, number]> = [
	[parseV6('fc00::'), 7], // unique-local
	[parseV6('fe80::'), 10], // link-local
	[parseV6('ff00::'), 8], // multicast
	[parseV6('2001:db8::'), 32], // documentation
	[parseV6('2001::'), 32], // Teredo
	[parseV6('2002::'), 16], // 6to4
	[parseV6('64:ff9b::'), 96], // NAT64 well-known prefix
	[parseV6('100::'), 64] // discard-only
];

export function ipv6BlockedBig(n: bigint): boolean {
	if (n >> 32n === 0n) return true; // ::/96 unspecified/loopback/v4-compatible
	if (n >> 32n === 0xffffn) return ipv4BlockedBig(n & 0xffffffffn); // IPv4-mapped
	for (const [net, bits] of V6_BLOCKS) {
		if (net === null) continue;
		const shift = BigInt(128 - bits);
		if (n >> shift === net >> shift) return true;
	}
	return false;
}

export type GuardResult = { ok: true; ips: string[] } | { ok: false; reason: string };

/**
 * Resolve a URL and confirm every address it maps to is publicly routable.
 *
 * All resolved addresses are checked, not just the first: a name with one public
 * and one private A record is the classic DNS-rebind setup, and picking the
 * first one would let the private one through.
 *
 * `allowPrivate` is the documented `ALLOW_PRIVATE_UPSTREAMS` escape hatch for a
 * deployment that runs its upstreams on loopback. It defaults off; when off this
 * function is the boundary and no caller may re-decide a target is safe.
 */
export async function assertPublicUpstream(
	rawUrl: string,
	allowPrivate = false
): Promise<GuardResult> {
	if (allowPrivate) return { ok: true, ips: [] };
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: 'base_url is not a valid URL' };
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, reason: `scheme ${url.protocol} is not allowed; use http or https` };
	}

	const host = url.hostname;
	if (!host) return { ok: false, reason: 'base_url has no host' };

	if (isBlockedLiteral(host)) {
		return { ok: false, reason: `refusing to call a non-public address (${host})` };
	}

	// A name, not a literal. Resolve it ourselves so the check is on the address
	// the socket will actually use — fetching the name and trusting fetch's own
	// resolution would check a different lookup than the one that connects.
	let ips: string[];
	try {
		const found = await lookup(host, { all: true, verbatim: true });
		ips = found.map((r) => r.address);
	} catch {
		return { ok: false, reason: `cannot resolve host (${host})` };
	}

	if (ips.length === 0) return { ok: false, reason: `host resolved to no addresses (${host})` };

	for (const ip of ips) {
		if (isBlockedLiteral(ip)) {
			return { ok: false, reason: `host ${host} resolves to a non-public address (${ip})` };
		}
	}

	return { ok: true, ips };
}

export interface GuardedFetchFailure {
	ok: false;
	/** A message safe to show an admin: names the guard, never the target's internals. */
	message: string;
}
export type GuardedFetchResult = { ok: true; response: Response } | GuardedFetchFailure;

/**
 * Fetch a provider URL with the SSRF guard applied.
 *
 * This is the one way an admin-supplied `base_url` may be fetched from the web
 * side. The guard used to live at two call sites with different strength — one
 * called `assertPublicUpstream` and the other a literal-only URL check — so the
 * weaker one won on the pages that most needed it. Centralising it means every
 * fetch gets DNS resolution, the allowlist check and the no-redirect rule, and a
 * new call site cannot forget any of them.
 *
 * `redirect: 'manual'` is not optional. A redirect is a second request to an
 * address nothing has checked, which is the whole attack; the router can re-guard
 * every hop at the socket but the web side has no dial hook, so it does not
 * follow at all.
 */
export async function guardedUpstreamFetch(
	baseUrl: unknown,
	allowPrivate: boolean,
	pathSuffix: string,
	init: RequestInit & { timeoutMs: number }
): Promise<GuardedFetchResult> {
	const guard = await assertPublicUpstream(String(baseUrl ?? ''), allowPrivate);
	if (!guard.ok) return { ok: false, message: guard.reason };
	const raw = String(baseUrl ?? '')
		.trim()
		.replace(/\/+$/, '');
	const url = `${raw}${pathSuffix}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
		return { ok: true, response };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : 'request failed' };
	} finally {
		clearTimeout(timer);
	}
}
