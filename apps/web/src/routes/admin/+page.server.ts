import { desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import {
	apiKey,
	connection,
	model,
	provider,
	requestLog,
	user
} from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.view');
	const [[providers], [models], [connections], [keys], [users], [reqAgg]] = await Promise.all([
		db.select({ n: sql<number>`count(*)::int` }).from(provider),
		db.select({ n: sql<number>`count(*)::int` }).from(model),
		db.select({ n: sql<number>`count(*)::int` }).from(connection),
		db
			.select({ n: sql<number>`count(*) filter (where ${apiKey.status} = 'active')::int` })
			.from(apiKey),
		db.select({ n: sql<number>`count(*)::int` }).from(user),
		db
			.select({
				n: sql<number>`count(*)::int`,
				tokens: sql<number>`coalesce(sum(${requestLog.tokensIn} + ${requestLog.tokensOut}), 0)::int`,
				costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
			})
			.from(requestLog)
	]);
	const topConsumers = await db
		.select({
			keyId: requestLog.apiKeyId,
			keyName: sql<string>`coalesce(${apiKey.name}, '—')`,
			email: sql<string>`coalesce(${user.email}, '—')`,
			requests: sql<number>`count(*)::int`,
			costMicro: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(user, eq(user.id, requestLog.userId))
		.groupBy(requestLog.apiKeyId, apiKey.name, user.email)
		.orderBy(sql`coalesce(sum(${requestLog.cost}), 0) desc`)
		.limit(8);
	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			requestedModel: requestLog.requestedModel,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status
		})
		.from(requestLog)
		.orderBy(desc(requestLog.createdAt))
		.limit(12);
	return {
		counts: {
			providers: providers.n,
			models: models.n,
			connections: connections.n,
			activeKeys: keys.n,
			users: users.n,
			requests: reqAgg.n,
			tokens: reqAgg.tokens,
			costMicro: reqAgg.costMicro
		},
		topConsumers,
		recent
	};
};
