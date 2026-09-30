/**
 * Request-log reads for the OBSERVE surfaces (PRD §28–29).
 *
 * Typed drizzle queries shared by the route loaders and the DB-backed tests,
 * so "the cursor walk has no gaps" is proven against the same SQL the page
 * runs. Every query is scoped by `project_id` — a request id alone must never
 * reach across a project boundary.
 *
 * Two source rules (PRD §96): long ranges read `usage_daily`, short ranges and
 * per-request fidelity read raw `request_log`. See `usage.ts` for the folds.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { ObserveDb as Db } from './db';
import {
	apiKey,
	environment,
	model,
	project,
	provider,
	providerModel,
	requestAttempt,
	requestLog
} from '$lib/server/db/schema';
import { decodeCursor, encodeCursor, type Cursor } from './cursor';
import { normalizeStatus, statusFilterValues } from './status';

export type RequestFilters = {
	from?: Date | null;
	to?: Date | null;
	status?: string | null;
	model?: string | null;
	provider?: string | null;
	apiKey?: string | null;
	environment?: string | null;
	endpoint?: string | null;
	requestId?: string | null;
	minLatencyMs?: number | null;
	maxLatencyMs?: number | null;
	minCostMicro?: bigint | null;
	maxCostMicro?: bigint | null;
};

/**
 * Parse the query-string filter surface in one place. Unparseable numbers fall
 * back to "no filter" rather than a 500: a hand-edited `?maxLatency=abc` must
 * not take down the page.
 */
export function parseFilters(params: URLSearchParams): RequestFilters {
	const num = (key: string): number | null => {
		const raw = params.get(key);
		if (raw == null || raw === '') return null;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : null;
	};
	const big = (key: string): bigint | null => {
		const raw = params.get(key);
		if (raw == null || raw === '') return null;
		try {
			const n = BigInt(raw);
			return n >= 0n ? n : null;
		} catch {
			return null;
		}
	};
	const date = (key: string, endOfDay = false): Date | null => {
		const raw = params.get(key);
		if (raw == null || raw === '') return null;
		// A date input sends `YYYY-MM-DD` with no time — it means the WHOLE day,
		// so `to=2026-09-30` must not stop at 00:00:00 and hide the day's rows.
		if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
			const d = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
			return Number.isNaN(d.getTime()) ? null : d;
		}
		const d = new Date(raw);
		return Number.isNaN(d.getTime()) ? null : d;
	};
	return {
		from: date('from'),
		to: date('to', true),
		status: params.get('status'),
		model: params.get('model'),
		provider: params.get('provider'),
		apiKey: params.get('key'),
		environment: params.get('env'),
		endpoint: params.get('endpoint'),
		requestId: params.get('requestId'),
		minLatencyMs: num('minLatency'),
		maxLatencyMs: num('maxLatency'),
		minCostMicro: big('minCost'),
		maxCostMicro: big('maxCost')
	};
}

/** WHERE for the request log: project scope + active filters + keyset cursor. */
export function requestWhere(
	projectId: string,
	f: RequestFilters,
	after?: Cursor | null
): SQL[] {
	const conds: SQL[] = [eq(requestLog.projectId, projectId)];
	if (f.from) conds.push(gte(requestLog.createdAt, f.from));
	if (f.to) conds.push(lte(requestLog.createdAt, f.to));
	if (f.status) {
		// A taxonomy filter expands to its stored forms so legacy rows surface:
		// `provider_error` matches `upstream_error`, `internal_error` matches `error`.
		const stored = statusFilterValues(normalizeStatus(f.status));
		conds.push(inArray(requestLog.status, stored));
	}
	if (f.model) conds.push(eq(requestLog.requestedModel, f.model));
	if (f.provider) conds.push(eq(requestLog.providerId, f.provider));
	if (f.apiKey) conds.push(eq(requestLog.apiKeyId, f.apiKey));
	if (f.environment) conds.push(eq(requestLog.environmentId, f.environment));
	if (f.endpoint) conds.push(eq(requestLog.endpoint, f.endpoint));
	if (f.requestId) conds.push(eq(requestLog.id, f.requestId));
	if (f.minLatencyMs != null) conds.push(gte(requestLog.latencyMs, f.minLatencyMs));
	if (f.maxLatencyMs != null) conds.push(lte(requestLog.latencyMs, f.maxLatencyMs));
	if (f.minCostMicro != null) conds.push(gte(requestLog.cost, f.minCostMicro));
	if (f.maxCostMicro != null) conds.push(lte(requestLog.cost, f.maxCostMicro));
	if (after) {
		// Keyset, not OFFSET: rows strictly after the cursor in (created_at, id)
		// descending order. Typed comparisons, not a raw fragment — a raw
		// `${after.createdAt}` bind hands postgres.js a bare Date it cannot
		// encode (`str()` wants string/Buffer), while the column's serializer
		// maps it correctly on every typed path.
		conds.push(
			or(
				lt(requestLog.createdAt, after.createdAt),
				and(eq(requestLog.createdAt, after.createdAt), lt(requestLog.id, after.id))
			) as SQL
		);
	}
	return conds;
}

export const LIST_COLUMNS = {
	id: requestLog.id,
	createdAt: requestLog.createdAt,
	status: requestLog.status,
	errorCode: requestLog.errorCode,
	httpStatus: requestLog.httpStatus,
	requestedModel: requestLog.requestedModel,
	modelSlug: model.slug,
	providerName: provider.name,
	latencyMs: requestLog.latencyMs,
	ttftMs: requestLog.ttftMs,
	tokensIn: requestLog.tokensIn,
	cachedInputTokens: requestLog.cachedInputTokens,
	tokensOut: requestLog.tokensOut,
	reasoningTokens: requestLog.reasoningTokens,
	totalTokens: requestLog.totalTokens,
	cost: requestLog.cost,
	currency: requestLog.currency,
	keyName: apiKey.name,
	keyPrefix: apiKey.prefix,
	clientIp: requestLog.clientIp,
	endpoint: requestLog.endpoint,
	attempts: requestLog.attempts,
	fallbackUsed: requestLog.fallbackUsed
};

export type RequestListRow = {
	id: string;
	createdAt: Date;
	status: string;
	errorCode: string | null;
	httpStatus: number | null;
	requestedModel: string | null;
	modelSlug: string | null;
	providerName: string | null;
	latencyMs: number;
	ttftMs: number | null;
	tokensIn: number;
	cachedInputTokens: number | null;
	tokensOut: number;
	reasoningTokens: number | null;
	totalTokens: number | null;
	cost: bigint;
	currency: string;
	keyName: string | null;
	keyPrefix: string | null;
	/** 0008 `inet` column as text; NULL on rows written before it existed. */
	clientIp: string | null;
	endpoint: string | null;
	attempts: number;
	fallbackUsed: boolean;
};

export type RequestPage = {
	rows: RequestListRow[];
	/** Cursor for the next page, null when the walk is exhausted. */
	nextCursor: string | null;
};

/**
 * One page of request rows. Reads `limit + 1` so "is there more?" costs no
 * COUNT over the high-volume table.
 */
export async function requestPage(
	db: Db,
	projectId: string,
	f: RequestFilters,
	after: Cursor | null,
	limit: number
): Promise<RequestPage> {
	const rows = (await db
		.select(LIST_COLUMNS)
		.from(requestLog)
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.leftJoin(provider, eq(provider.id, requestLog.providerId))
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.where(and(...requestWhere(projectId, f, after)))
		.orderBy(desc(requestLog.createdAt), desc(requestLog.id))
		.limit(limit + 1)) as RequestListRow[];
	const page = rows.slice(0, limit);
	const tail = page[page.length - 1];
	return {
		rows: page,
		nextCursor: rows.length > limit && tail ? encodeCursor({ createdAt: tail.createdAt, id: tail.id }) : null
	};
}

export function cursorFromParam(raw: string | null | undefined): Cursor | null {
	return decodeCursor(raw);
}

/** Distinct dimension values for filter dropdowns, scoped to the project. */
export async function filterOptions(db: Db, projectId: string): Promise<{
	models: string[];
	providers: { id: string | null; name: string | null }[];
	keys: { id: string | null; name: string | null; prefix: string | null }[];
	environments: { id: string; name: string }[];
	endpoints: string[];
}> {
	const scope = eq(requestLog.projectId, projectId);
	const [modelRows, providerRows, keyRows, envRows, endpointRows] = await Promise.all([
		db
			.selectDistinct({ value: requestLog.requestedModel })
			.from(requestLog)
			.where(and(scope, isNotNull(requestLog.requestedModel)))
			.orderBy(requestLog.requestedModel),
		db
			.selectDistinct({ id: requestLog.providerId, name: provider.name })
			.from(requestLog)
			.leftJoin(provider, eq(provider.id, requestLog.providerId))
			.where(and(scope, isNotNull(requestLog.providerId))),
		db
			.selectDistinct({ id: requestLog.apiKeyId, name: apiKey.name, prefix: apiKey.prefix })
			.from(requestLog)
			.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
			.where(and(scope, isNotNull(requestLog.apiKeyId))),
		db
			.select({ id: environment.id, name: environment.name })
			.from(environment)
			.where(eq(environment.projectId, projectId))
			.orderBy(environment.name),
		db
			.selectDistinct({ value: requestLog.endpoint })
			.from(requestLog)
			.where(and(scope, isNotNull(requestLog.endpoint)))
			.orderBy(requestLog.endpoint)
	]);
	return {
		models: modelRows.map((r) => r.value ?? ''),
		providers: providerRows,
		keys: keyRows,
		environments: envRows,
		endpoints: endpointRows.map((r) => r.value ?? '')
	};
}

export type RequestDetailRow = RequestListRow & {
	userId: string | null;
	workspaceId: string | null;
	environmentId: string | null;
	environmentName: string | null;
	projectName: string;
	providerId: string | null;
	providerModelId: string | null;
	providerModelName: string | null;
	connectionId: string | null;
	resolvedSlug: string | null;
	strategy: string | null;
	routingPolicyId: string | null;
	error: string | null;
	timing: Record<string, number> | null;
	providerCostMicro: bigint | null;
	creditChargedMicro: bigint | null;
	inputPriceMicro: string | null;
	cachedInputPriceMicro: string | null;
	outputPriceMicro: string | null;
	reasoningPriceMicro: string | null;
	pricingRuleId: string | null;
	requestBody: string | null;
	responseBody: string | null;
	/** 0008 `inet` column, selected as text; NULL on rows written before it. */
	clientIp: string | null;
	stream: boolean;
	clientDisconnected: boolean;
};

export type AttemptRow = {
	id: string;
	attempt: number;
	providerId: string | null;
	providerName: string | null;
	connectionId: string | null;
	providerModelId: string | null;
	httpStatus: number | null;
	errorCode: string | null;
	retryable: boolean | null;
	latencyMs: number;
	ttftMs: number | null;
	providerCostMicro: bigint | null;
	reason: string | null;
	startedAt: Date;
	finishedAt: Date | null;
};

/** The full request row + attempts. Project-scoped; null row = not found/not yours. */
export async function requestDetail(
	db: Db,
	projectId: string,
	requestId: string
): Promise<{ row: RequestDetailRow | null; attempts: AttemptRow[] }> {
	const rows = (await db
		.select({
			...LIST_COLUMNS,
			userId: requestLog.userId,
			workspaceId: requestLog.workspaceId,
			environmentId: requestLog.environmentId,
			environmentName: environment.name,
			projectName: project.name,
			providerId: requestLog.providerId,
			providerModelId: requestLog.providerModelId,
			providerModelName: providerModel.providerModelId,
			connectionId: requestLog.connectionId,
			resolvedSlug: model.slug,
			strategy: requestLog.strategy,
			routingPolicyId: requestLog.routingPolicyId,
			error: requestLog.error,
			timing: requestLog.timing,
			providerCostMicro: requestLog.providerCostMicro,
			creditChargedMicro: requestLog.creditChargedMicro,
			inputPriceMicro: requestLog.inputPriceMicro,
			cachedInputPriceMicro: requestLog.cachedInputPriceMicro,
			outputPriceMicro: requestLog.outputPriceMicro,
			reasoningPriceMicro: requestLog.reasoningPriceMicro,
			pricingRuleId: requestLog.pricingRuleId,
			requestBody: requestLog.requestBody,
			responseBody: requestLog.responseBody,
			// 0008's inet column through the schema mirror; pg renders inet as its
			// text form, so the row type is a plain string.
			clientIp: requestLog.clientIp,
			stream: requestLog.stream,
			clientDisconnected: requestLog.clientDisconnected
		})
		.from(requestLog)
		.innerJoin(project, eq(project.id, requestLog.projectId))
		.leftJoin(environment, eq(environment.id, requestLog.environmentId))
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.leftJoin(provider, eq(provider.id, requestLog.providerId))
		.leftJoin(providerModel, eq(providerModel.id, requestLog.providerModelId))
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.where(and(eq(requestLog.projectId, projectId), eq(requestLog.id, requestId)))
		.limit(1)) as RequestDetailRow[];
	const attempts = (await db
		.select({
			id: requestAttempt.id,
			attempt: requestAttempt.attempt,
			providerId: requestAttempt.providerId,
			providerName: provider.name,
			connectionId: requestAttempt.connectionId,
			providerModelId: requestAttempt.providerModelId,
			httpStatus: requestAttempt.httpStatus,
			errorCode: requestAttempt.errorCode,
			retryable: requestAttempt.retryable,
			latencyMs: requestAttempt.latencyMs,
			ttftMs: requestAttempt.ttftMs,
			providerCostMicro: requestAttempt.providerCostMicro,
			reason: requestAttempt.reason,
			startedAt: requestAttempt.startedAt,
			finishedAt: requestAttempt.finishedAt
		})
		.from(requestAttempt)
		.leftJoin(provider, eq(provider.id, requestAttempt.providerId))
		.where(eq(requestAttempt.requestId, requestId))
		.orderBy(asc(requestAttempt.attempt))) as AttemptRow[];
	return { row: rows[0] ?? null, attempts };
}

/** The timing keys the detail page renders, in PRD §29 order. */
export const TIMING_KEYS = [
	'auth',
	'rate_limit',
	'routing',
	'queue',
	'connection',
	'generation'
] as const;

/**
 * The detail page's Timing rows (PRD §29): each measured stage in order, then
 * TTFT and the request total. A stage the router never recorded is a `null`
 * row — rendered as a dash, never as 0 ms.
 */
export function timingRows(
	timing: Record<string, number> | null,
	ttftMs: number | null,
	totalMs: number
): { key: string; ms: number | null }[] {
	const rows: { key: string; ms: number | null }[] = TIMING_KEYS.map((key) => ({
		key,
		ms: timing?.[key] ?? null
	}));
	rows.push({ key: 'ttft', ms: ttftMs }, { key: 'total', ms: totalMs });
	return rows;
}
