import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { observeGate } from '$lib/server/observe/scope';
import {
	cursorFromParam,
	filterOptions,
	parseFilters,
	requestPage,
	type RequestFilters
} from '$lib/server/observe/request-queries';
import { normalizeStatus, statusTone, REQUEST_STATUSES } from '$lib/server/observe/status';

/**
 * Request logs (PRD §28): one page of rows by KEYSET cursor (PRD §119), with
 * the filter surface of §28 (date range/status/model/provider/API key/
 * environment/endpoint/request ID/latency/cost). Money crosses to the page as
 * strings (repo convention — never a float).
 */
const PAGE_SIZE = 25;

const EMPTY = {
	rows: [] as never[],
	options: { models: [], providers: [], keys: [], environments: [], endpoints: [] },
	nextCursor: null,
	nextHref: null,
	filters: {} as Record<string, string>,
	statuses: REQUEST_STATUSES
};

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requireCap(locals, 'member');
	const gate = await observeGate(locals, params.projectId, 'request.read');
	if (gate.denied) return { denied: true, queryError: null, ...EMPTY };
	try {
		const filters = parseFilters(url.searchParams);
		const after = cursorFromParam(url.searchParams.get('cursor'));
		const [page, rawOptions] = await Promise.all([
			requestPage(db, gate.project.id, filters, after, PAGE_SIZE),
			filterOptions(db, gate.project.id)
		]);
		// The cursor is dropped from the filter echo: applying filters restarts
		// the walk at the newest row, while `nextHref` re-applies THIS page's
		// filters plus the next cursor.
		const filterQuery = new URLSearchParams(url.searchParams);
		filterQuery.delete('cursor');
		const nextQuery = new URLSearchParams(filterQuery);
		if (page.nextCursor) nextQuery.set('cursor', page.nextCursor);
		return {
			denied: false,
			queryError: null,
			projectId: gate.project.id,
			projectName: gate.project.name,
			filters: echo(filters),
			statuses: REQUEST_STATUSES,
			options: {
				models: rawOptions.models,
				providers: rawOptions.providers,
				keys: rawOptions.keys.filter((k) => k.id),
				environments: rawOptions.environments,
				endpoints: rawOptions.endpoints
			},
			rows: page.rows.map((r) => ({
				id: r.id,
				createdAt: r.createdAt,
				status: normalizeStatus(r.status),
				storedStatus: r.status,
				tone: statusTone(normalizeStatus(r.status)),
				requestedModel: r.requestedModel,
				modelSlug: r.modelSlug,
				providerName: r.providerName,
				latencyMs: r.latencyMs,
				ttftMs: r.ttftMs,
				tokensIn: r.tokensIn,
				tokensOut: r.tokensOut,
				totalTokens: r.totalTokens,
				costMicro: r.cost.toString(),
				currency: r.currency,
				keyName: r.keyName,
				keyPrefix: r.keyPrefix,
				clientIp: r.clientIp,
				httpStatus: r.httpStatus,
				attempts: r.attempts,
				fallbackUsed: r.fallbackUsed
			})),
			nextCursor: page.nextCursor,
			nextHref: page.nextCursor ? `?${nextQuery}` : null
		};
	} catch (err) {
		console.error('[requests] load failed', err);
		return {
			denied: false,
			queryError: 'The request log could not be read.',
			projectId: params.projectId,
			projectName: '',
			...EMPTY
		};
	}
};

/** Filters echoed back to the form: money as strings, everything else as-is. */
function echo(f: RequestFilters): Record<string, string> {
	const out: Record<string, string> = {};
	const put = (k: string, v: string | number | bigint | Date | null | undefined) => {
		if (v == null || v === '') return;
		out[k] = v instanceof Date ? v.toISOString() : String(v);
	};
	put('from', f.from);
	put('to', f.to);
	put('status', f.status);
	put('model', f.model);
	put('provider', f.provider);
	put('key', f.apiKey);
	put('env', f.environment);
	put('endpoint', f.endpoint);
	put('requestId', f.requestId);
	put('minLatency', f.minLatencyMs);
	put('maxLatency', f.maxLatencyMs);
	put('minCost', f.minCostMicro);
	put('maxCost', f.maxCostMicro);
	return out;
}
