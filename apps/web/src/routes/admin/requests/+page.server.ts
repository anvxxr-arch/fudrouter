import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, model, provider, requestLog, user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.requests');

	const status = url.searchParams.get('status');
	const where = status ? eq(requestLog.status, status) : undefined;

	const rows = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			email: user.email,
			keyName: apiKey.name,
			keyPrefix: apiKey.prefix,
			modelSlug: model.slug,
			providerName: provider.name,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status,
			error: requestLog.error
		})
		.from(requestLog)
		.innerJoin(user, eq(user.id, requestLog.userId))
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.leftJoin(provider, eq(provider.id, requestLog.providerId))
		.where(where)
		.orderBy(desc(requestLog.createdAt))
		.limit(200);

	return { rows, status: status ?? '' };
};
