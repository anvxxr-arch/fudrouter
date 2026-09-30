/**
 * Usage and analytics reads (PRD §37–39, §96–97).
 *
 * Source rule: ranges >= 7 days read the `usage_daily` rollup; shorter ranges
 * read raw `request_log`. A long range whose aggregate buckets are empty (the
 * rollup worker has not run) falls back to raw rows and reports `source: 'raw'`
 * so the page can label the numbers instead of showing a confident zero.
 *
 * The folds and percentiles live in `metrics.ts`; this module only moves rows.
 * Money aggregates come back as strings from SQL and become bigint here — the
 * driver's numeric type must never reach a float.
 */
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { ObserveDb as Db } from './db';
import {
	apiKey,
	environment,
	model,
	project,
	provider,
	requestLog,
	usageDaily
} from '$lib/server/db/schema';
import {
	addTotals,
	EMPTY_TOTALS,
	mergeHistograms,
	percentileFromHistogram,
	type UsageTotals
} from './metrics';

/** Aggregate ranges are 7 days or longer (PRD §96). */
export const AGGREGATE_RANGE_DAYS = 7;

export type TotalsScope = {
	workspaceId: string;
	projectId?: string | null;
	/** Environment-scope budgets (PRD §40) need env-scoped consumption. */
	environmentId?: string | null;
};
export type UsageSource = 'aggregates' | 'raw';

function aggWhere(s: TotalsScope, from: Date, to: Date): SQL[] {
	const conds: SQL[] = [
		eq(usageDaily.workspaceId, s.workspaceId),
		gte(usageDaily.bucketStart, from),
		lte(usageDaily.bucketStart, to)
	];
	if (s.projectId) conds.push(eq(usageDaily.projectId, s.projectId));
	if (s.environmentId) conds.push(eq(usageDaily.environmentId, s.environmentId));
	return conds;
}

function rawWhere(s: TotalsScope, from: Date, to: Date): SQL[] {
	const conds: SQL[] = [
		eq(requestLog.workspaceId, s.workspaceId),
		gte(requestLog.createdAt, from),
		lte(requestLog.createdAt, to)
	];
	if (s.projectId) conds.push(eq(requestLog.projectId, s.projectId));
	if (s.environmentId) conds.push(eq(requestLog.environmentId, s.environmentId));
	return conds;
}

type TotalsRow = {
	requests: number;
	successes: number;
	tokensIn: number;
	cachedInputTokens: number;
	tokensOut: number;
	reasoningTokens: number;
	totalTokens: number;
	costMicro: string;
	latencyMsSum: number;
	ttftMsSum: number;
	fallbackCount: number;
	retryCount: number;
	histogram: Record<string, number> | null;
};

function totalsFromRow(row: TotalsRow): UsageTotals {
	return addTotals(EMPTY_TOTALS, {
		requests: Number(row.requests),
		successes: Number(row.successes),
		tokensIn: Number(row.tokensIn),
		cachedInputTokens: Number(row.cachedInputTokens),
		tokensOut: Number(row.tokensOut),
		reasoningTokens: Number(row.reasoningTokens),
		totalTokens: Number(row.totalTokens),
		costMicro: BigInt(row.costMicro),
		latencyMsSum: Number(row.latencyMsSum),
		ttftMsSum: Number(row.ttftMsSum),
		fallbackCount: Number(row.fallbackCount),
		retryCount: Number(row.retryCount),
		histogram: row.histogram ?? {}
	});
}

async function totalsFromAggregates(db: Db, where: SQL[]): Promise<UsageTotals> {
	const rows = (await db
		.select({
			requests: sql<number>`coalesce(sum(${usageDaily.requests}), 0)::bigint`,
			successes: sql<number>`coalesce(sum(${usageDaily.successes}), 0)::bigint`,
			tokensIn: sql<number>`coalesce(sum(${usageDaily.tokensIn}), 0)::bigint`,
			cachedInputTokens: sql<number>`coalesce(sum(${usageDaily.cachedInputTokens}), 0)::bigint`,
			tokensOut: sql<number>`coalesce(sum(${usageDaily.tokensOut}), 0)::bigint`,
			reasoningTokens: sql<number>`coalesce(sum(${usageDaily.reasoningTokens}), 0)::bigint`,
			totalTokens: sql<number>`coalesce(sum(${usageDaily.totalTokens}), 0)::bigint`,
			costMicro: sql<string>`coalesce(sum(${usageDaily.costMicro}), 0)`,
			latencyMsSum: sql<number>`coalesce(sum(${usageDaily.latencyMsSum}), 0)::bigint`,
			ttftMsSum: sql<number>`coalesce(sum(${usageDaily.ttftMsSum}), 0)::bigint`,
			fallbackCount: sql<number>`coalesce(sum(${usageDaily.fallbackCount}), 0)::bigint`,
			retryCount: sql<number>`coalesce(sum(${usageDaily.retryCount}), 0)::bigint`,
			// Bucket maps merge additively in SQL so the fold is one row. The
			// subquery carries its own FROM + WHERE over the same rows the outer
			// aggregate reads — a correlated form (`usage_daily.latency_histogram`
			// borrowed from the outer select) is rejected as an ungrouped column,
			// and per-bucket sums must still work across several rollup rows.
			histogram: sql<Record<string, number> | null>`coalesce((
				SELECT jsonb_object_agg(k, v) FROM (
					SELECT e.k, sum(e.v::int) AS v
					FROM ${usageDaily}, jsonb_each_text(coalesce(${usageDaily}.latency_histogram, '{}'::jsonb)) AS e(k, v)
					WHERE ${and(...where)}
					GROUP BY e.k
				) merged
			), '{}'::jsonb)`
		})
		.from(usageDaily)
		.where(and(...where))) as unknown as TotalsRow[];
	return rows[0] ? totalsFromRow(rows[0]) : EMPTY_TOTALS;
}

async function totalsFromRaw(db: Db, where: SQL[]): Promise<UsageTotals> {
	const rows = (await db
		.select({
			requests: sql<number>`count(*)::bigint`,
			successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::bigint`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::bigint`,
			cachedInputTokens: sql<number>`coalesce(sum(coalesce(${requestLog.cachedInputTokens}, 0)), 0)::bigint`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::bigint`,
			reasoningTokens: sql<number>`coalesce(sum(coalesce(${requestLog.reasoningTokens}, 0)), 0)::bigint`,
			totalTokens: sql<number>`coalesce(sum(coalesce(${requestLog.totalTokens}, 0)), 0)::bigint`,
			costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
			creditsMicro: sql<string>`coalesce(sum(coalesce(${requestLog.creditChargedMicro}, 0)), 0)`,
			latencyMsSum: sql<number>`coalesce(sum(${requestLog.latencyMs}), 0)::bigint`,
			ttftMsSum: sql<number>`coalesce(sum(coalesce(${requestLog.ttftMs}, 0)), 0)::bigint`,
			fallbackCount: sql<number>`count(*) filter (where ${requestLog.fallbackUsed})::bigint`,
			retryCount: sql<number>`coalesce(sum(greatest(${requestLog.attempts} - 1, 0)), 0)::bigint`,
			// Raw rows fold into the bucket map in SQL so percentiles never need
			// every latency shipped into JS (spec §8 bucket list).
			histogram: sql<Record<string, number> | null>`jsonb_build_object(
				'50', count(*) filter (where ${requestLog.latencyMs} <= 50),
				'100', count(*) filter (where ${requestLog.latencyMs} > 50 and ${requestLog.latencyMs} <= 100),
				'250', count(*) filter (where ${requestLog.latencyMs} > 100 and ${requestLog.latencyMs} <= 250),
				'500', count(*) filter (where ${requestLog.latencyMs} > 250 and ${requestLog.latencyMs} <= 500),
				'1000', count(*) filter (where ${requestLog.latencyMs} > 500 and ${requestLog.latencyMs} <= 1000),
				'2500', count(*) filter (where ${requestLog.latencyMs} > 1000 and ${requestLog.latencyMs} <= 2500),
				'5000', count(*) filter (where ${requestLog.latencyMs} > 2500 and ${requestLog.latencyMs} <= 5000),
				'10000', count(*) filter (where ${requestLog.latencyMs} > 5000 and ${requestLog.latencyMs} <= 10000),
				'25000', count(*) filter (where ${requestLog.latencyMs} > 10000 and ${requestLog.latencyMs} <= 25000),
				'60000', count(*) filter (where ${requestLog.latencyMs} > 25000 and ${requestLog.latencyMs} <= 60000),
				'inf', count(*) filter (where ${requestLog.latencyMs} > 60000)
			)`
		})
		.from(requestLog)
		.where(and(...where))) as unknown as TotalsRow[];
	return rows[0] ? totalsFromRow(rows[0]) : EMPTY_TOTALS;
}

/**
 * Usage totals over a window (PRD §37 metrics). `source` is what the numbers
 * were computed from — the UI says "aggregates not yet rolled up" when a long
 * range had to fall back to raw rows.
 */
export async function usageTotals(
	db: Db,
	s: TotalsScope,
	from: Date,
	to: Date
): Promise<{ totals: UsageTotals; source: UsageSource }> {
	const days = (to.getTime() - from.getTime()) / 86_400_000;
	if (days >= AGGREGATE_RANGE_DAYS) {
		const agg = await totalsFromAggregates(db, aggWhere(s, from, to));
		// Empty aggregates + existing raw rows = rollup lag, not no traffic.
		if (agg.requests > 0) return { totals: agg, source: 'aggregates' };
		return { totals: await totalsFromRaw(db, rawWhere(s, from, to)), source: 'raw' };
	}
	return { totals: await totalsFromRaw(db, rawWhere(s, from, to)), source: 'raw' };
}

/**
 * Credits charged in a window — always a raw sum of `credit_charged_micro`
 * (the amount posted to `credit_ledger` per request). `usage_daily` carries no
 * credits column, so this never reads aggregates: 0 here means zero, and a
 * rollup gap cannot fake it.
 */
export async function creditsCharged(
	db: Db,
	s: TotalsScope,
	from: Date,
	to: Date
): Promise<bigint> {
	const rows = await db
		.select({ credits: sql<string>`coalesce(sum(coalesce(${requestLog.creditChargedMicro}, 0)), 0)` })
		.from(requestLog)
		.where(and(...rawWhere(s, from, to)));
	const row = rows[0] as { credits: string } | undefined;
	return BigInt(row?.credits ?? '0');
}

// ---------------------------------------------------------- breakdowns ---

export type BreakRow = {
	key: string;
	label: string;
	requests: number;
	totalTokens: number;
	costMicro: bigint;
};

export type UsageBreakdowns = {
	byProject: BreakRow[];
	byEnvironment: BreakRow[];
	byApiKey: BreakRow[];
	byModel: BreakRow[];
	byProvider: BreakRow[];
	byDay: BreakRow[];
};

type Shape = {
	key: string | null;
	label: string | null;
	requests: number;
	totalTokens: number;
	costMicro: string;
};

const foldBreak = (rows: Shape[]): BreakRow[] =>
	rows.map((r) => ({
		key: r.key ?? '',
		label: r.label ?? '',
		requests: Number(r.requests),
		totalTokens: Number(r.totalTokens),
		costMicro: BigInt(r.costMicro)
	}));

/**
 * PRD §37 breakdowns: project / environment / API key / model / provider / day.
 * Model groups by the RESOLVED canonical slug in both sources (`usage_daily`
 * carries model_id only), and a request that died before a model resolved rolls
 * up under "Unresolved" rather than vanishing.
 */
export async function usageBreakdowns(
	db: Db,
	s: TotalsScope,
	from: Date,
	to: Date,
	source: UsageSource
): Promise<UsageBreakdowns> {
	const agg = source === 'aggregates';
	const table = agg ? usageDaily : requestLog;
	const where = agg ? aggWhere(s, from, to) : rawWhere(s, from, to);
	const requests = agg
		? sql<number>`coalesce(sum(${usageDaily.requests}), 0)::bigint`
		: sql<number>`count(*)::bigint`;
	const totalTokens = agg
		? sql<number>`coalesce(sum(${usageDaily.totalTokens}), 0)::bigint`
		: sql<number>`coalesce(sum(coalesce(${requestLog.totalTokens}, 0)), 0)::bigint`;
	const costMicro = agg
		? sql<string>`coalesce(sum(${usageDaily.costMicro}), 0)`
		: sql<string>`coalesce(sum(${requestLog.cost}), 0)`;
	const dims = {
		project: agg ? usageDaily.projectId : requestLog.projectId,
		environment: agg ? usageDaily.environmentId : requestLog.environmentId,
		apiKey: agg ? usageDaily.apiKeyId : requestLog.apiKeyId,
		model: agg ? usageDaily.modelId : requestLog.modelId,
		provider: agg ? usageDaily.providerId : requestLog.providerId
	};
	const dayExpr = agg
		? sql<string>`to_char(${usageDaily.bucketStart}, 'YYYY-MM-DD')`
		: sql<string>`to_char(${requestLog.createdAt}, 'YYYY-MM-DD')`;
	const [byProject, byEnvironment, byApiKey, byModel, byProvider, byDay] = await Promise.all([
		db
			.select({ key: dims.project, label: project.name, requests, totalTokens, costMicro })
			.from(table)
			.leftJoin(project, eq(project.id, dims.project))
			.where(and(...where))
			.groupBy(dims.project, project.name),
		db
			.select({ key: dims.environment, label: environment.name, requests, totalTokens, costMicro })
			.from(table)
			.leftJoin(environment, eq(environment.id, dims.environment))
			.where(and(...where))
			.groupBy(dims.environment, environment.name),
		db
			.select({ key: dims.apiKey, label: apiKey.name, requests, totalTokens, costMicro })
			.from(table)
			.leftJoin(apiKey, eq(apiKey.id, dims.apiKey))
			.where(and(...where))
			.groupBy(dims.apiKey, apiKey.name),
		db
			.select({
				key: dims.model,
				label: sql<string | null>`coalesce(${model.slug}, 'Unresolved')`,
				requests,
				totalTokens,
				costMicro
			})
			.from(table)
			.leftJoin(model, eq(model.id, dims.model))
			.where(and(...where))
			.groupBy(dims.model, model.slug),
		db
			.select({ key: dims.provider, label: provider.name, requests, totalTokens, costMicro })
			.from(table)
			.leftJoin(provider, eq(provider.id, dims.provider))
			.where(and(...where))
			.groupBy(dims.provider, provider.name),
		db
			.select({ key: dayExpr, label: dayExpr, requests, totalTokens, costMicro })
			.from(table)
			.where(and(...where))
			.groupBy(dayExpr)
	]);
	return {
		byProject: foldBreak(byProject as Shape[]),
		byEnvironment: foldBreak(byEnvironment as Shape[]),
		byApiKey: foldBreak(byApiKey as Shape[]),
		byModel: foldBreak(byModel as unknown as Shape[]),
		byProvider: foldBreak(byProvider as Shape[]),
		byDay: foldBreak(byDay as Shape[]).sort((a, b) => a.key.localeCompare(b.key))
	};
}

// ---------------------------------------------------------- analytics ---

export type AnalyticsStats = {
	requestCount: number;
	successCount: number;
	errorCount: number;
	successRate: number;
	errorRate: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	/**
	 * How the percentiles were produced: exact over raw rows, or the bucket
	 * upper-bound estimate from a rollup histogram. The UI labels it.
	 */
	latencySource: 'exact' | 'estimated';
	/** Mean TTFT over rows that reported one; null when none did. */
	ttftMs: number | null;
	/** (output + reasoning) tokens per second of latency; null when unknown. */
	tokensPerSecond: number | null;
	fallbackRate: number;
	retryRate: number;
	providerDistribution: { key: string; label: string; count: number }[];
	modelDistribution: { key: string; label: string; count: number }[];
	histogram: Record<string, number>;
	source: UsageSource;
};

function rate(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

type DistRow = { key: string | null; label: string | null; count: number };

const foldDist = (rows: DistRow[]) =>
	rows.map((r) => ({ key: r.key ?? '', label: r.label ?? '', count: Number(r.count) }));

/**
 * Engineering metrics (PRD §38). Raw ranges take exact percentiles straight
 * from the rows (`percentile_cont`); rollup ranges estimate from the merged
 * bucket histogram (same math the raw rows fold into), so both report the same
 * shape and the label says which one it is.
 */
export async function analyticsStats(
	db: Db,
	s: TotalsScope,
	from: Date,
	to: Date
): Promise<AnalyticsStats> {
	const days = (to.getTime() - from.getTime()) / 86_400_000;
	let source: UsageSource = 'raw';
	let totals: UsageTotals;
	if (days >= AGGREGATE_RANGE_DAYS) {
		const agg = await totalsFromAggregates(db, aggWhere(s, from, to));
		if (agg.requests > 0) {
			source = 'aggregates';
			totals = agg;
		} else {
			totals = await totalsFromRaw(db, rawWhere(s, from, to));
		}
	} else {
		totals = await totalsFromRaw(db, rawWhere(s, from, to));
	}
	const where = rawWhere(s, from, to);
	const [ttftRows, providerRows, modelRows, exactRows] = await Promise.all([
		db
			.select({ avg: sql<number | null>`avg(${requestLog.ttftMs})` })
			.from(requestLog)
			.where(and(...where, sql`${requestLog.ttftMs} is not null`)),
		db
			.select({
				key: requestLog.providerId,
				label: provider.name,
				count: sql<number>`count(*)::bigint`
			})
			.from(requestLog)
			.leftJoin(provider, eq(provider.id, requestLog.providerId))
			.where(and(...where))
			.groupBy(requestLog.providerId, provider.name),
		db
			.select({
				key: requestLog.modelId,
				label: sql<string | null>`coalesce(${model.slug}, 'Unresolved')`,
				count: sql<number>`count(*)::bigint`
			})
			.from(requestLog)
			.leftJoin(model, eq(model.id, requestLog.modelId))
			.where(and(...where))
			.groupBy(requestLog.modelId, model.slug),
		db
			.select({
				p50: sql<number | null>`percentile_cont(0.5) within group (order by ${requestLog.latencyMs})`,
				p95: sql<number | null>`percentile_cont(0.95) within group (order by ${requestLog.latencyMs})`,
				p99: sql<number | null>`percentile_cont(0.99) within group (order by ${requestLog.latencyMs})`
			})
			.from(requestLog)
			.where(and(...where))
	]);
	const histogram = mergeHistograms([totals.histogram]);
	const errors = totals.requests - totals.successes;
	const ttftAvg = (ttftRows as unknown as { avg: number | null }[])[0]?.avg ?? null;
	// Raw rows give exact percentiles; a rollup range can only estimate from the
	// bucket map, and the UI labels the numbers accordingly.
	const exact = (exactRows as unknown as { p50: number | null; p95: number | null; p99: number | null }[])[0] ?? {
		p50: null,
		p95: null,
		p99: null
	};
	const fromAggregates = source === 'aggregates';
	return {
		requestCount: totals.requests,
		successCount: totals.successes,
		errorCount: errors,
		successRate: rate(totals.successes, totals.requests),
		errorRate: rate(errors, totals.requests),
		p50: fromAggregates ? percentileFromHistogram(histogram, 50) : exact.p50,
		p95: fromAggregates ? percentileFromHistogram(histogram, 95) : exact.p95,
		p99: fromAggregates ? percentileFromHistogram(histogram, 99) : exact.p99,
		latencySource: fromAggregates ? 'estimated' : 'exact',
		ttftMs: ttftAvg == null ? null : Math.round(ttftAvg),
		tokensPerSecond:
			totals.latencyMsSum > 0 ? (totals.tokensOut * 1000) / totals.latencyMsSum : null,
		fallbackRate: rate(totals.fallbackCount, totals.requests),
		retryRate: rate(totals.retryCount, totals.requests),
		providerDistribution: foldDist(providerRows as unknown as DistRow[]),
		modelDistribution: foldDist(modelRows as unknown as DistRow[]),
		histogram,
		source
	};
}

// ------------------------------------------------------- cost analytics ---

export type CostStats = {
	costMicro: bigint;
	providerCostMicro: bigint | null;
	markupMicro: bigint | null;
	creditsMicro: bigint;
	totalTokens: number;
	requests: number;
	byProvider: CostBreak[];
	byModel: CostBreak[];
	byEnvironment: CostBreak[];
	byProject: CostBreak[];
};

export type CostBreak = { key: string; label: string; costMicro: bigint; providerCostMicro: bigint };

/**
 * Cost analytics (PRD §39) always reads RAW rows: `usage_daily` carries no
 * `provider_cost_micro`, so provider cost and markup are only honest from the
 * per-request ledger. This is exactly what `SUM(request_log.cost)` computes for
 * the same range — the reconciliation test asserts that.
 *
 * The optional "estimated savings" metric (PRD §39) is deliberately ABSENT:
 * there is no baseline price table and no baseline snapshot on the rows, so no
 * baseline is computable and the page omits the whole figure rather than print
 * one that is not real. When a baseline source lands, its math goes here and
 * only here does the UI gain the field.
 */
export async function costStats(
	db: Db,
	s: TotalsScope,
	from: Date,
	to: Date
): Promise<CostStats> {
	const where = rawWhere(s, from, to);
	const [totalsRows, providerCostRows, byProvider, byModel, byEnvironment, byProject] =
		await Promise.all([
			db
				.select({
					costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
					creditsMicro: sql<string>`coalesce(sum(coalesce(${requestLog.creditChargedMicro}, 0)), 0)`,
					totalTokens: sql<number>`coalesce(sum(coalesce(${requestLog.totalTokens}, 0)), 0)::bigint`,
					requests: sql<number>`count(*)::bigint`
				})
				.from(requestLog)
				.where(and(...where)),
			db
				.select({
					// NULL = no row reported a provider cost (legacy rows); a zero
					// would claim "the provider charged nothing".
					providerCostMicro: sql<string | null>`sum(${requestLog.providerCostMicro})`
				})
				.from(requestLog)
				.where(and(...where, sql`${requestLog.providerCostMicro} is not null`)),
			db
				.select({
					key: requestLog.providerId,
					label: provider.name,
					costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
					providerCostMicro: sql<string>`coalesce(sum(coalesce(${requestLog.providerCostMicro}, 0)), 0)`
				})
				.from(requestLog)
				.leftJoin(provider, eq(provider.id, requestLog.providerId))
				.where(and(...where))
				.groupBy(requestLog.providerId, provider.name),
			db
				.select({
					key: requestLog.modelId,
					label: sql<string | null>`coalesce(${model.slug}, 'Unresolved')`,
					costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
					providerCostMicro: sql<string>`coalesce(sum(coalesce(${requestLog.providerCostMicro}, 0)), 0)`
				})
				.from(requestLog)
				.leftJoin(model, eq(model.id, requestLog.modelId))
				.where(and(...where))
				.groupBy(requestLog.modelId, model.slug),
			db
				.select({
					key: requestLog.environmentId,
					label: environment.name,
					costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
					providerCostMicro: sql<string>`coalesce(sum(coalesce(${requestLog.providerCostMicro}, 0)), 0)`
				})
				.from(requestLog)
				.leftJoin(environment, eq(environment.id, requestLog.environmentId))
				.where(and(...where))
				.groupBy(requestLog.environmentId, environment.name),
			db
				.select({
					key: requestLog.projectId,
					label: project.name,
					costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)`,
					providerCostMicro: sql<string>`coalesce(sum(coalesce(${requestLog.providerCostMicro}, 0)), 0)`
				})
				.from(requestLog)
				.leftJoin(project, eq(project.id, requestLog.projectId))
				.where(and(...where))
				.groupBy(requestLog.projectId, project.name)
		]);
	const totalsRow = (totalsRows as unknown as {
		costMicro: string;
		creditsMicro: string;
		totalTokens: number;
		requests: number;
	}[])[0];
	const providerCostRow = (providerCostRows as unknown as { providerCostMicro: string | null }[])[0];
	const providerCostMicro =
		providerCostRow?.providerCostMicro == null ? null : BigInt(providerCostRow.providerCostMicro);
	const fold = (rows: unknown): CostBreak[] =>
		(rows as { key: string | null; label: string | null; costMicro: string; providerCostMicro: string }[]).map(
			(r) => ({
				key: r.key ?? '',
				label: r.label ?? '',
				costMicro: BigInt(r.costMicro),
				providerCostMicro: BigInt(r.providerCostMicro)
			})
		);
	const costMicro = BigInt(totalsRow?.costMicro ?? '0');
	return {
		costMicro,
		providerCostMicro,
		markupMicro: providerCostMicro == null ? null : costMicro - providerCostMicro,
		creditsMicro: BigInt(totalsRow?.creditsMicro ?? '0'),
		totalTokens: Number(totalsRow?.totalTokens ?? 0),
		requests: Number(totalsRow?.requests ?? 0),
		byProvider: fold(byProvider),
		byModel: fold(byModel),
		byEnvironment: fold(byEnvironment),
		byProject: fold(byProject)
	};
}
