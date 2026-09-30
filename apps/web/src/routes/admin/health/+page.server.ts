import { and, gte, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { connection, credential, provider, requestLog } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
// Health (PRD §66-side observability): observed outcomes per provider and
// connection over the last 24h from the request log — not a synthetic probe —
// plus the stored health state the data plane writes.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const last24h = gte(requestLog.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000));
	const pct95 = sql<number>`coalesce(percentile_cont(0.95) within group (order by ${requestLog.latencyMs}), 0)::int`;
	const byProvider = await db
		.select({
			providerId: requestLog.providerId,
			requests: sql<number>`count(*)::int`,
			successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			p95: pct95
		})
		.from(requestLog)
		.where(last24h)
		.groupBy(requestLog.providerId);
	const byConnection = await db
		.select({
			connectionId: requestLog.connectionId,
			requests: sql<number>`count(*)::int`,
			successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			p95: pct95
		})
		.from(requestLog)
		.where(and(last24h, sql`${requestLog.connectionId} is not null`))
		.groupBy(requestLog.connectionId);
	// Error mix: non-success codes grouped per provider / connection.
	const errors = await db
		.select({
			providerId: requestLog.providerId,
			connectionId: requestLog.connectionId,
			code: sql<string>`coalesce(${requestLog.errorCode}, ${requestLog.status})`,
			n: sql<number>`count(*)::int`
		})
		.from(requestLog)
		.where(and(last24h, sql`${requestLog.status} != 'success'`))
		.groupBy(requestLog.providerId, requestLog.connectionId, sql`coalesce(${requestLog.errorCode}, ${requestLog.status})`);
	const providers = await db
		.select({ id: provider.id, name: provider.name, status: provider.status })
		.from(provider)
		.orderBy(provider.name);
	const connections = await db
		.select({
			id: connection.id,
			providerId: connection.providerId,
			name: connection.name,
			region: connection.region,
			enabled: connection.enabled,
			healthStatus: connection.healthStatus
		})
		.from(connection)
		.orderBy(connection.name);
	const creds = await db
		.select({
			connectionId: credential.connectionId,
			total: sql<number>`count(*)::int`,
			healthy: sql<number>`count(*) filter (where ${credential.status} = 'healthy')::int`
		})
		.from(credential)
		.groupBy(credential.connectionId);
	const provStats = new Map(byProvider.map((p) => [p.providerId, p]));
	const connStats = new Map(byConnection.map((c) => [c.connectionId, c]));
	const credsByConn = new Map(creds.map((c) => [c.connectionId, c]));
	const errByProv = new Map<string, { code: string; n: number }[]>();
	const errByConn = new Map<string, { code: string; n: number }[]>();
	for (const e of errors) {
		if (e.providerId) {
			const provList = errByProv.get(e.providerId) ?? [];
			provList.push({ code: e.code, n: e.n });
			errByProv.set(e.providerId, provList);
		}
		if (e.connectionId) {
			const connList = errByConn.get(e.connectionId) ?? [];
			connList.push({ code: e.code, n: e.n });
			errByConn.set(e.connectionId, connList);
		}
	}
	return {
		providers: providers.map((p) => {
			const s = provStats.get(p.id);
			return {
				...p,
				requests: s?.requests ?? 0,
				successes: s?.successes ?? 0,
				p95: s?.p95 ?? 0,
				errorMix: (errByProv.get(p.id) ?? []).sort((a, b) => b.n - a.n)
			};
		}),
		connections: connections.map((c) => {
			const s = connStats.get(c.id);
			const cr = credsByConn.get(c.id);
			return {
				...c,
				requests: s?.requests ?? 0,
				successes: s?.successes ?? 0,
				p95: s?.p95 ?? 0,
				errorMix: (errByConn.get(c.id) ?? []).sort((a, b) => b.n - a.n),
				credentialsTotal: cr?.total ?? 0,
				credentialsHealthy: cr?.healthy ?? 0
			};
		})
	};
};
