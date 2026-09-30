import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, project, requestLog } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { vk } from '$lib/server/vk';
// Throttling view (PRD §65, §96 side): what the rate limiter actually rejected,
// grouped by the scope-ish dimensions the request log records. Read-only.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const throttled = or(
		eq(requestLog.status, 'rate_limited'),
		eq(requestLog.errorCode, 'RATE_LIMITED')
	);
	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			apiKeyId: requestLog.apiKeyId,
			keyName: apiKey.name,
			projectId: requestLog.projectId,
			projectName: project.name,
			workspaceId: requestLog.workspaceId,
			status: requestLog.status,
			errorCode: requestLog.errorCode,
			httpStatus: requestLog.httpStatus
		})
		.from(requestLog)
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(project, eq(project.id, requestLog.projectId))
		.where(and(throttled, gte(requestLog.createdAt, since)))
		.orderBy(desc(requestLog.createdAt))
		.limit(200);
	// Hourly counts per (api_key, project): date_trunc('hour') on the window.
	const hourly = await db
		.select({
			hour: sql<string>`date_trunc('hour', ${requestLog.createdAt})`,
			apiKeyId: requestLog.apiKeyId,
			keyName: apiKey.name,
			projectId: requestLog.projectId,
			projectName: project.name,
			n: sql<number>`count(*)::int`
		})
		.from(requestLog)
		.leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
		.leftJoin(project, eq(project.id, requestLog.projectId))
		.where(and(throttled, gte(requestLog.createdAt, since)))
		.groupBy(
			sql`date_trunc('hour', ${requestLog.createdAt})`,
			requestLog.apiKeyId,
			apiKey.name,
			requestLog.projectId,
			project.name
		)
		.orderBy(desc(sql`date_trunc('hour', ${requestLog.createdAt})`), desc(sql`count(*)`))
		.limit(100);
	// Valkey concurrency gauges (`conc:{scope}:{id}` per spec §12), best-effort:
	// without Valkey there is simply no live gauge to show.
	let concurrency: { key: string; inFlight: number }[] = [];
	const client = vk();
	if (client) {
		try {
			const keys = await client.keys('conc:*');
			if (keys.length > 0) {
				const values = await client.mget(keys);
				concurrency = keys
					.map((key, i) => ({ key, inFlight: Number(values[i] ?? 0) }))
					.filter((c) => c.inFlight > 0)
					.sort((a, b) => b.inFlight - a.inFlight)
					.slice(0, 50);
			}
		} catch {
			concurrency = [];
		}
	}
	return {
		recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
		hourly,
		concurrency,
		valkeyUp: concurrency.length > 0 || client !== null
	};
};
