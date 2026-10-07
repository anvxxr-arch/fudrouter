/**
 * Upstream catalog discovery for the admin console.
 *
 * Reading a provider's `/models` is what lets an admin publish slugs without
 * typing them: this fetches the list, and `../provider-catalog` parses it into
 * the shape the gallery edits. The fetch is guarded — `base_url` is
 * admin-supplied, so an unvalidated request is a request-forgery primitive.
 */
import { eq } from 'drizzle-orm';
import { guardedUpstreamFetch } from './ssrf';
import { allowPrivateUpstreams } from './publish-env';
import { safeUpstreamUrl } from './admin-limits';
import { parseUpstreamModels, type UpstreamModel } from '../provider-catalog';
import type { Credentials } from './credentials';
import { headersFor, tokenAt } from './provider-credentials';
import { db } from './db';
import { provider } from './db/schema';

/** How long any single upstream call may take. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** One provider row, or null when the id does not exist. */
export async function getProvider(id: string) {
	const [row] = await db.select().from(provider).where(eq(provider.id, id)).limit(1);
	return row ?? null;
}

/** What a catalog read returns. */
export interface CatalogResult {
	models: UpstreamModel[];
	status: number;
	url: string;
	rateLimit: Record<string, string>;
}

/**
 * Fetch and parse the upstream catalog.
 *
 * Guarded: `base_url` is admin-supplied, so this is a request-forgery primitive
 * until the target is checked. `safeUpstreamUrl` screens the host string, and
 * `guardedUpstreamFetch` resolves the name, refuses a redirect (a redirect is a
 * second request to an address nothing has checked) and owns the timeout and
 * abort, so an early return cannot leak a timer.
 */
export async function fetchUpstreamCatalog(
	baseUrl: string,
	cred: Credentials,
	index = 0
): Promise<CatalogResult> {
	const base = safeUpstreamUrl(baseUrl, allowPrivateUpstreams());
	if (!base) throw new Error('provider base URL is not a usable http(s) URL');
	const headers = headersFor(cred, tokenAt(cred, index));
	const guarded = await guardedUpstreamFetch(baseUrl, allowPrivateUpstreams(), '/models', {
		headers,
		timeoutMs: UPSTREAM_TIMEOUT_MS
	});
	if (!guarded.ok) throw new Error(guarded.message);
	const res = guarded.response;
	const rateLimit: Record<string, string> = {};
	for (const [k, v] of res.headers.entries()) {
		if (k.startsWith('x-ratelimit') || k === 'retry-after') rateLimit[k] = v;
	}
	if (!res.ok) return { models: [], status: res.status, url: `${base}/models`, rateLimit };
	return {
		models: parseUpstreamModels(await res.json()),
		status: res.status,
		url: `${base}/models`,
		rateLimit
	};
}
