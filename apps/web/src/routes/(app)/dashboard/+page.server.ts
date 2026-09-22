import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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

	return { totals, activeKeys, recent };
};
