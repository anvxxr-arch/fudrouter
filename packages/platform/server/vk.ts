import { createHash } from 'node:crypto';
// Named import, not default: under `moduleResolution: nodenext` (which models the
// runtime, plain node ESM) the default import of this CJS module is typed as the
// namespace, not the constructor. Both bindings exist at runtime; the named one is
// the one TS can type.
import { Redis } from 'ioredis';
/**
 * Valkey client — the runtime acceleration layer (docs/specs/2026-09-30-
 * platform-schema.md §12). Caches, counters, locks and transient state ONLY;
 * PostgreSQL stays the source of truth and every durable value must be
 * reconstructable without this client.
 *
 * `VALKEY_URL` selects the endpoint (spec §12: never hardcoded). An absent or
 * empty `VALKEY_URL` disables the client cleanly — callers see `null` and use
 * their PostgreSQL / in-process fallback — so a deployment without Valkey runs
 * unchanged.
 *
 * Degradation rule (spec §12): connection failure degrades OPEN (allow requests,
 * treat caches as cold) with at most one warning per minute. A dead Valkey must
 * never take the platform down with it (PRD §150).
 */

let client: Redis | null = null;
let warnedAt = 0;

function warnOnce(msg: string): void {
	const now = Date.now();
	if (now - warnedAt > 60_000) {
		warnedAt = now;
		console.warn(`[vk] ${msg}`);
	}
}

/** The shared client, or null when VALKEY_URL is unset/disabled. */
export function vk(): Redis | null {
	if (client) return client;
	const url = process.env.VALKEY_URL;
	if (!url) return null;
	try {
		client = new Redis(url, {
			lazyConnect: true,
			maxRetriesPerRequest: 1,
			retryStrategy: (times) => Math.min(times * 200, 2000),
			// Degrade open: a broken Valkey logs once a minute and callers fall
			// back to their PostgreSQL path rather than failing the request.
			enableOfflineQueue: false
		});
		client.on('error', (e) => warnOnce(`connection error: ${e.message}`));
		return client;
	} catch (e) {
		warnOnce(`disabled: ${(e as Error).message}`);
		return null;
	}
}

/**
 * Close the shared Valkey client, if one was ever created.
 *
 * Why this exists: `vk()` lazily creates a module-level `Redis` whose sockets
 * keep the Node event loop alive, and nothing owns it. In production the process
 * is the owner. In a test process it is a hang — `jobs.ts` imports this module,
 * so any test reaching the job queue leaks the connection and the runner waits
 * out its full timeout on a test that already passed.
 *
 * Idempotent: a second call is a no-op, so a `finally` that runs after a failed
 * connect does not throw.
 */
export async function closeVk(): Promise<void> {
	if (!client) return;
	const c = client;
	client = null;
	try {
		await c.quit();
	} catch {
		// A client that never connected has nothing to quit; disconnecting is
		// the only way to release its socket.
		c.disconnect();
	}
}

/**
 * Fixed-window rate-limit check (spec §12 `rl:{scope}:{id}:rpm` etc).
 * Returns true when the request is within `limit` per `windowMs`, false when it
 * must be rejected, and null when Valkey could not answer (caller degrades open).
 */
export async function allowRate(key: string, limit: number, windowMs: number): Promise<boolean | null> {
	const c = vk();
	if (!c) return null;
	try {
		const n = await c.incr(key);
		// NX, not bare PEXPIRE: the window starts at the FIRST hit and must not
		// slide on every request. And setting it here at all (rather than only in
		// a pipeline) would leak an immortal counter if the process died between
		// INCR and PEXPIRE — NX keeps the pairing harmless when it already exists.
		if (n === 1) await c.pexpire(key, windowMs, 'NX');
		return n <= limit;
	} catch {
		warnOnce('rate check failed — degrading open');
		return null;
	}
}

export async function getJSON<T>(key: string): Promise<T | null> {
	const c = vk();
	if (!c) return null;
	try {
		const raw = await c.get(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		warnOnce('cache read failed — treating as cold');
		return null;
	}
}

export async function setJSON(key: string, value: unknown, ttlMs: number): Promise<void> {
	const c = vk();
	if (!c) return;
	try {
		await c.set(key, JSON.stringify(value), 'PX', Math.max(1, ttlMs));
	} catch {
		warnOnce('cache write failed');
	}
}

/** In-flight gauge up; returns the new count, or null on failure. */
export async function incrConc(key: string, ttlMs: number): Promise<number | null> {
	const c = vk();
	if (!c) return null;
	try {
		const n = await c.incr(key);
		// NX: same leak guard as allowRate — a counter abandoned mid-request must
		// not become a permanent gauge.
		if (n === 1) await c.pexpire(key, ttlMs, 'NX');
		return n;
	} catch {
		warnOnce('concurrency incr failed — degrading open');
		return null;
	}
}

export async function decrConc(key: string): Promise<void> {
	const c = vk();
	if (!c) return;
	try {
		await c.decr(key);
	} catch {
		warnOnce('concurrency decr failed');
	}
}

// NOTE on the INCR/PEXPIRE NX pairing above: the counter keeps whatever TTL it
// got at first increment, so a crash after INCR can leave a key with no TTL only
// if PEXPIRE NX never ran — bounded by Valkey's own maxmemory policy in that
// case, and by the window itself otherwise.

/** Bump a cache generation counter (`ver:{table}`) after a durable write. */
export async function bumpVersion(table: string): Promise<void> {
	const c = vk();
	if (!c) return;
	try {
		await c.incr(`ver:${table}`);
	} catch {
		warnOnce('version bump failed');
	}
}

/**
 * The router's per-database cache namespace, reproduced exactly.
 *
 * The Go data plane derives it as `sha256(host:port/database)[:10]` from its
 * DATABASE_URL (backend/go/internal/store/store.go cacheNamespaceFor) and
 * prefixes every Valkey entry with `rt:<ns>:`. The console must spell it
 * identically to invalidate a router entry — a mismatch would delete nothing
 * and silently leave a revoked key authenticating for the TTL.
 *
 * Credentials are deliberately excluded: the namespace is not a secret and must
 * never put one in a cache key.
 */
export function cacheNamespace(databaseUrl: string): string {
	try {
		const u = new URL(databaseUrl);
		const host = u.hostname;
		const port = u.port || '5432';
		const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
		return createHash('sha256').update(`${host}:${port}/${db}`).digest('hex').slice(0, 10);
	} catch {
		return 'unknown';
	}
}

/**
 * Delete the router's cached API key row for `prefix` (proxy/apikey_cache.go).
 *
 * Called on revoke so "revocation takes effect immediately for new requests"
 * (public.mjs) holds. Best-effort: a Valkey outage must not fail the revoke,
 * and the router's 30s TTL bounds the window it was always going to be.
 */
export async function invalidateApiKeyCache(prefix: string): Promise<void> {
	const c = vk();
	if (!c || !prefix) return;
	const ns = cacheNamespace(process.env.DATABASE_URL ?? '');
	try {
		await c.del(`rt:${ns}:apikey:${prefix}`);
	} catch {
		warnOnce('api key cache invalidation failed');
	}
}
