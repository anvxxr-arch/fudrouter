import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, model, provider, requestLog, user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.view');

	const [providers, models, activeKeys, users] = await Promise.all([
		db.$count(provider),
		db.$count(model),
		db.$count(apiKey, isNull(apiKey.revokedAt)),
		db.$count(user)
	]);

	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog);

	// Top resource consumers, per client key (answers "which key burns the most").
	const topKeys = await db
		.select({
			name: apiKey.name,
			prefix: apiKey.prefix,
			email: user.email,
			requests: sql<number>`count(*)::int`,
			tokens: sql<number>`coalesce(sum(${requestLog.tokensIn} + ${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.innerJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.innerJoin(user, eq(user.id, requestLog.userId))
		.groupBy(apiKey.id, apiKey.name, apiKey.prefix, user.email)
		.orderBy(desc(sql`sum(${requestLog.cost})`))
		.limit(5);

	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			email: user.email,
			modelSlug: model.slug,
			status: requestLog.status,
			latencyMs: requestLog.latencyMs,
			cost: requestLog.cost,
			currency: requestLog.currency
		})
		.from(requestLog)
		.innerJoin(user, eq(user.id, requestLog.userId))
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.orderBy(desc(requestLog.createdAt))
		.limit(8);

	return { providers, models, activeKeys, users, totals, topKeys, recent };
};
