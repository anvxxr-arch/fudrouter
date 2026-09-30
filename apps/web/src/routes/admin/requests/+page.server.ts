import { and, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { cleanField } from '$lib/server/admin-vocab';
import { db } from '$lib/server/db';
import { apiKey, connection, model, provider, requestLog, user } from '$lib/server/db/schema';

// Stored status vocabulary (spec §8 taxonomy + S0 spellings still in the table).
const STATUSES = [
	'success',
	'client_error',
	'provider_error',
	'timeout',
	'rate_limited',
	'cancelled',
	'internal_error',
	'error',
	'upstream_error'
] as const;

/** A `YYYY-MM-DD` bound as an exact UTC instant; unparseable input = no bound. */
function parseDay(raw: string | null | undefined, endOfDay: boolean): Date | null {
	const v = (raw ?? '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
	const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.requests');
	// Read-only list: no bodies cross this boundary (PRD §93-94).
	const status = cleanField(url.searchParams.get('status'), 40);
	const errorCode = cleanField(url.searchParams.get('error_code'), 120);
	const modelFilter = cleanField(url.searchParams.get('model'), 200);
	const providerFilter = cleanField(url.searchParams.get('provider'), 64);
	const from = parseDay(url.searchParams.get('from'), false);
	const to = parseDay(url.searchParams.get('to'), true);

	const conds: SQL[] = [];
	if (status) conds.push(eq(requestLog.status, status));
	if (errorCode) conds.push(eq(requestLog.errorCode, errorCode));
	if (modelFilter) {
		// Match either what the client asked for or what it resolved to.
		conds.push(
			or(eq(requestLog.requestedModel, modelFilter), eq(model.slug, modelFilter)) as SQL
		);
	}
	if (providerFilter) conds.push(eq(requestLog.providerId, providerFilter));
	if (from) conds.push(gte(requestLog.createdAt, from));
	if (to) conds.push(lte(requestLog.createdAt, to));
	const where = conds.length > 0 ? and(...conds) : undefined;

	const rows = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			email: user.email,
			keyName: apiKey.name,
			requestedModel: requestLog.requestedModel,
			modelSlug: model.slug,
			providerName: provider.name,
			connectionName: connection.name,
			strategy: requestLog.strategy,
			attempts: requestLog.attempts,
			fallbackUsed: requestLog.fallbackUsed,
			ttftMs: requestLog.ttftMs,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status,
			errorCode: requestLog.errorCode,
			httpStatus: requestLog.httpStatus,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency
		})
		.from(requestLog)
		.leftJoin(user, eq(user.id, requestLog.userId))
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(model, eq(model.id, requestLog.modelId))
		.leftJoin(provider, eq(provider.id, requestLog.providerId))
		.leftJoin(connection, eq(connection.id, requestLog.connectionId))
		.where(where)
		.orderBy(desc(requestLog.createdAt))
		.limit(200);

	const providers = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.orderBy(provider.name);

	return {
		rows,
		providers,
		statuses: STATUSES as readonly string[],
		filters: {
			status: status ?? '',
			errorCode: errorCode ?? '',
			model: modelFilter ?? '',
			provider: providerFilter ?? '',
			from: url.searchParams.get('from') ?? '',
			to: url.searchParams.get('to') ?? ''
		}
	};
};
