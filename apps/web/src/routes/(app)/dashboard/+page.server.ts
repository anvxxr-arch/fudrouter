import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, model, requestLog } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.userId, userId));

	const activeKeys = await db.$count(
		apiKey,
		and(eq(apiKey.userId, userId), isNull(apiKey.revokedAt))
	);

	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			modelSlug: model.slug,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status
		})
		.from(requestLog)
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.userId, userId))
		.orderBy(desc(requestLog.createdAt))
		.limit(10);

	// Two weeks of daily buckets for the dashboard chart. Bucketed in JS — a
	// single user's window is small, and doing it here keeps the day keys exactly
	// the ones the labels show (UTC) rather than depending on the database's
	// timezone. Move this to SQL when a user's log outgrows a page load.
	const since = new Date();
	since.setUTCHours(0, 0, 0, 0);
	since.setUTCDate(since.getUTCDate() - 13);

	const window = await db
		.select({
			createdAt: requestLog.createdAt,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost
		})
		.from(requestLog)
		.where(and(eq(requestLog.userId, userId), gte(requestLog.createdAt, since)));

	const byDay = new Map<string, { requests: number; tokens: number; cost: bigint }>();
	for (const row of window) {
		const key = row.createdAt.toISOString().slice(0, 10);
		const bucket = byDay.get(key) ?? { requests: 0, tokens: 0, cost: 0n };
		bucket.requests += 1;
		bucket.tokens += row.tokensIn + row.tokensOut;
		bucket.cost += row.cost;
		byDay.set(key, bucket);
	}
	const series = Array.from({ length: 14 }, (_, i) => {
		const day = new Date(since);
		day.setUTCDate(since.getUTCDate() + i);
		const key = day.toISOString().slice(0, 10);
		const bucket = byDay.get(key) ?? { requests: 0, tokens: 0, cost: 0n };
		return {
			day: key,
			requests: bucket.requests,
			tokens: bucket.tokens,
			cost: bucket.cost.toString()
		};
	});

	return { totals, activeKeys, recent, series };
};
