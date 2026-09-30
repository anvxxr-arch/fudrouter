import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for admin-initiated requests to a provider's base_url.
 *
 * The router already refuses to dial loopback/RFC1918/link-local/CGNAT
 * (services/router/internal/proxy/guard.go, enforced at the socket via
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
 * Exported so the URL-sanitiser in `$lib/server/admin-limits` and the guard here
 * agree: they were two independent implementations of the same rule, and the weaker one
 * (in admin-limits) was missing `0.0.0.0`, `::`, `198.18/15`, `::ffff:` mapped
 * IPv6 and `fe80::%zone`. A stored base_url could name any of those and pass a
 * "safety" check that reported it as private-space-free.
 *
 * A literal cannot be laundered through a DNS rebind, which is why this runs
 * before any resolution: it is the only check that always applies, whatever the
 * host turns out to resolve to.
 */
export function isBlockedLiteral(host: string): boolean {
	const ip = normalizeIp(host);
	if (!ip) return false;
	if (ip === '::1' || ip === '0.0.0.0' || ip === '::') return true;

	// IPv6 loopback/unspecified, plus the IPv4-mapped forms the kernel accepts
	// for them (::ffff:127.0.0.1 is a loopback connect).
	const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	if (mapped !== ip) {
		// Hex spelling, e.g. `7f00:1` for 127.0.0.1: `new URL()` rewrites a dotted
		// pair to hex, so `[::ffff:127.0.0.1]` reaches here as `::ffff:7f00:1` —
		// the form every real base_url takes, because it came through a URL
		// parser. Checking for the dotted prefix alone silently passes it.
		const hx = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hx) {
			const hi = parseInt(hx[1], 16);
			const lo = parseInt(hx[2], 16);
			return isBlockedLiteral(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
		}
		return isBlockedLiteral(mapped);
	}
	if (mapped === '::1' || mapped === '::' || mapped === '0.0.0.0') return true;
	// IPv6 ranges a dotted-quad check cannot see: link-local (fe80::/10),
	// unique-local (fc00::/7) and multicast (ff00::/8).
	if (/^fe[89ab]/.test(mapped)) return true;
	if (/^f[cd]/.test(mapped)) return true;
	if (/^ff/.test(mapped)) return true;

	// Private, link-local, and the cloud metadata endpoint.
	if (/^10\./.test(mapped)) return true;
	if (/^192\.168\./.test(mapped)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(mapped)) return true;
	if (/^169\.254\./.test(mapped)) return true;
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(mapped)) return true; // CGNAT
	if (/^198\.(18|19)\./.test(mapped)) return true; // benchmarking
	if (/^127\./.test(mapped)) return true;
	return false;
}

function normalizeIp(host: string): string | null {
	let h = host.trim().toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	// Zone id on a link-local literal, e.g. fe80::1%eth0.
	const zone = h.indexOf('%');
	if (zone !== -1) h = h.slice(0, zone);
	if (isIP(h)) return h;
	return null;
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
