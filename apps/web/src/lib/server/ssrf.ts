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

// Blocked on sight, before any DNS work: a literal address in the URL cannot be
// laundered through a rebind.
function isBlockedLiteral(host: string): boolean {
	const ip = normalizeIp(host);
	if (!ip) return false;
	if (ip === '::1' || ip === '0.0.0.0' || ip === '::') return true;

	// IPv6 loopback/unspecified, plus the IPv4-mapped forms the kernel accepts
	// for them (::ffff:127.0.0.1 is a loopback connect).
	const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	if (mapped !== ip) return isBlockedLiteral(mapped);
	if (mapped === '::1' || mapped === '::' || mapped === '0.0.0.0') return true;

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

export type GuardResult =
	| { ok: true; ips: string[] }
	| { ok: false; reason: string };

/**
 * Resolve a URL and confirm every address it maps to is publicly routable.
 *
 * All resolved addresses are checked, not just the first: a name with one public
 * and one private A record is the classic DNS-rebind setup, and picking the
 * first one would let the private one through.
 */
export async function assertPublicUpstream(rawUrl: string): Promise<GuardResult> {
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
