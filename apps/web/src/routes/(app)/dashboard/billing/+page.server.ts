import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { model, requestLog } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';

// Metered cost, not a wallet. Every figure below is a sum over the request_log rows
// this account owns, and nothing is charged — so there is no balance to report.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const userId = locals.user!.id;

	const [allTime] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`,
			currency: sql<string>`coalesce(min(${requestLog.currency}), 'USD')`
		})
		.from(requestLog)
		.where(eq(requestLog.userId, userId));

	// The month window is UTC on purpose: the dashboard chart buckets by UTC day, and
	// two different "months" on one account would be a bug report waiting to happen.
	const monthStart = new Date();
	monthStart.setUTCDate(1);
	monthStart.setUTCHours(0, 0, 0, 0);

	const [month] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(and(eq(requestLog.userId, userId), gte(requestLog.createdAt, monthStart)));

	const byModel = await db
		.select({
			slug: model.slug,
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.userId, userId))
		.groupBy(model.slug)
		.orderBy(sql`sum(${requestLog.cost}) desc`)
		.limit(50);

	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			modelSlug: model.slug,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency,
			status: requestLog.status
		})
		.from(requestLog)
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.userId, userId))
		.orderBy(desc(requestLog.createdAt))
		.limit(20);

	// How many models this account has actually used, so the capped table below can
	// say what it left out instead of implying it is the whole picture.
	const [distinctModels] = await db
		.select({ n: sql<number>`count(distinct ${requestLog.modelId})::int` })
		.from(requestLog)
		.where(eq(requestLog.userId, userId));

	return { allTime, month, byModel, modelCount: distinctModels.n, recent };
};
