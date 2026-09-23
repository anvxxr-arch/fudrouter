import { desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { model, requestLog } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	// Aggregated in SQL, not in JS: request_log is the highest-volume table and
	// this must not pull every row into the app to add them up.
	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.userId, userId));

	const recent = await db
		.select({
			id: requestLog.id,
			modelSlug: model.slug,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status,
			error: requestLog.error,
			createdAt: requestLog.createdAt
		})
		.from(requestLog)
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.userId, userId))
		.orderBy(desc(requestLog.createdAt))
		.limit(50);

	return { totals, recent };
};
