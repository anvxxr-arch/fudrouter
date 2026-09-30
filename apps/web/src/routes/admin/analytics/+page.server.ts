import { and, gte, lt, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { model, provider, requestLog, usageDaily, usageHourly } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
// Analytics (PRD §96): usage rollups from usage_daily/usage_hourly, with an
// honest fallback to request_log date_trunc aggregation when the rollup tables
// are empty for the window. Latency percentiles always come from the raw log —
// the rollups keep sums and a histogram, not exact percentiles.
type Dim = { id: string; name: string };
type Lat = { p50: number; p95: number; p99: number };
const parseDay = (value: string | null, fallback: Date): Date => {
	if (!value) return fallback;
	const d = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(d.getTime()) ? fallback : d;
};
export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.view');
	const to = parseDay(url.searchParams.get('to'), new Date());
	const from = parseDay(url.searchParams.get('from'), new Date(to.getTime() - 7 * 86_400_000));
	const window = and(gte(requestLog.createdAt, from), lt(requestLog.createdAt, to));
	// Rollups first: if usage_daily covers the window we sum it (requests,
	// successes, tokens, cost) and read names from the catalog tables.
	const daily = await db
		.select({
			modelId: usageDaily.modelId,
			providerId: usageDaily.providerId,
			requests: sql<number>`coalesce(sum(${usageDaily.requests}), 0)::int`,
			successes: sql<number>`coalesce(sum(${usageDaily.successes}), 0)::int`,
			tokensIn: sql<number>`coalesce(sum(${usageDaily.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${usageDaily.tokensOut}), 0)::int`,
			costMicro: sql<string>`coalesce(sum(${usageDaily.costMicro}), 0)::text`
		})
		.from(usageDaily)
		.where(and(gte(usageDaily.bucketStart, from), lt(usageDaily.bucketStart, to)))
		.groupBy(usageDaily.modelId, usageDaily.providerId);
	let usingRollups = daily.length > 0;
	let rows = daily;
	if (!usingRollups) {
		// Fallback: aggregate the raw request log for the same window.
		rows = await db
			.select({
				modelId: requestLog.modelId,
				providerId: requestLog.providerId,
				requests: sql<number>`count(*)::int`,
				successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
				tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
				costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
			})
			.from(requestLog)
			.where(window)
			.groupBy(requestLog.modelId, requestLog.providerId);
	}
	// Latency percentiles — exact, from the raw log over the same window.
	const pct = (p: number) =>
		sql<number>`coalesce(percentile_cont(${sql.raw(String(p))}) within group (order by ${requestLog.latencyMs}), 0)::int`;
	const latencyByModel = await db
		.select({
			modelId: requestLog.modelId,
			p50: pct(0.5),
			p95: pct(0.95),
			p99: pct(0.99)
		})
		.from(requestLog)
		.where(window)
		.groupBy(requestLog.modelId);
	const latencyByProvider = await db
		.select({
			providerId: requestLog.providerId,
			p50: pct(0.5),
			p95: pct(0.95),
			p99: pct(0.99)
		})
		.from(requestLog)
		.where(window)
		.groupBy(requestLog.providerId);
	const models = await db.select({ id: model.id, name: model.name, slug: model.slug }).from(model);
	const providers = await db.select({ id: provider.id, name: provider.name }).from(provider);
	const modelName = new Map<string, Dim>(models.map((m) => [m.id, { id: m.id, name: m.slug }]));
	const providerName = new Map<string, Dim>(
		providers.map((p) => [p.id, { id: p.id, name: p.name }])
	);
	const latModel = new Map<string, Lat>();
	for (const l of latencyByModel) if (l.modelId) latModel.set(l.modelId, l);
	const latProvider = new Map<string, Lat>();
	for (const l of latencyByProvider) if (l.providerId) latProvider.set(l.providerId, l);
	// Aggregate the row stream into the two report shapes.
	const byModel = new Map<string, { id: string; name: string; requests: number; successes: number; tokensIn: number; tokensOut: number; costMicro: string }>();
	const byProvider = new Map<string, { id: string; name: string; requests: number; successes: number; tokensIn: number; tokensOut: number; costMicro: string }>();
	const bump = (
		map: Map<string, { id: string; name: string; requests: number; successes: number; tokensIn: number; tokensOut: number; costMicro: string }>,
		key: string,
		name: string,
		r: (typeof rows)[number]
	) => {
		const cur =
			map.get(key) ??
			({ id: key, name, requests: 0, successes: 0, tokensIn: 0, tokensOut: 0, costMicro: '0' });
		cur.requests += r.requests;
		cur.successes += r.successes;
		cur.tokensIn += r.tokensIn;
		cur.tokensOut += r.tokensOut;
		cur.costMicro = (BigInt(cur.costMicro) + BigInt(r.costMicro)).toString();
		map.set(key, cur);
	};
	for (const r of rows) {
		if (r.modelId) bump(byModel, r.modelId, modelName.get(r.modelId)?.name ?? r.modelId, r);
		if (r.providerId)
			bump(byProvider, r.providerId, providerName.get(r.providerId)?.name ?? r.providerId, r);
	}
	const attachLatency = <R extends { id: string }>(rows: R[], lat: Map<string, Lat>) =>
		rows.map((r) => ({
			...r,
			p50: lat.get(r.id)?.p50 ?? 0,
			p95: lat.get(r.id)?.p95 ?? 0,
			p99: lat.get(r.id)?.p99 ?? 0
		}));
	return {
		from: from.toISOString().slice(0, 10),
		to: to.toISOString().slice(0, 10),
		usingRollups,
		byModel: attachLatency([...byModel.values()].sort((a, b) => b.requests - a.requests), latModel),
		byProvider: attachLatency(
			[...byProvider.values()].sort((a, b) => b.requests - a.requests),
			latProvider
		)
	};
};
