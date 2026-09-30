import { desc, ne, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { connection, incident, provider, requestLog, systemEvent } from '$lib/server/db/schema';

export type ComponentHealth = 'operational' | 'degraded' | 'outage';

/**
 * Derivation (PRD §72): the three inputs are the 24h observed success rate,
 * open incidents and the latest health snapshot. An open incident overrides
 * traffic — a component with a `critical` incident is `outage` whatever the
 * success rate says, any other open incident is at least `degraded`. Without an
 * incident the success rate decides: below 50% is `outage`, below 99% is
 * `degraded`. A latest snapshot of `unhealthy`/`degraded` caps the result the
 * same way an incident does at its own severity.
 */
function deriveHealth(input: {
	requests: number;
	successRate: number | null;
	openIncidents: { severity: string }[];
	latestSnapshot: string | null;
}): ComponentHealth {
	if (input.openIncidents.some((i) => i.severity === 'critical')) return 'outage';
	if (input.latestSnapshot === 'unhealthy') return 'outage';
	if (input.requests > 0 && input.successRate !== null && input.successRate < 50) return 'outage';
	if (input.openIncidents.length > 0) return 'degraded';
	if (input.latestSnapshot === 'degraded') return 'degraded';
	if (input.requests > 0 && input.successRate !== null && input.successRate < 99) return 'degraded';
	return 'operational';
}

type RawRow = Record<string, unknown>;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

	const providers = await db
		.select({
			id: provider.id,
			name: provider.name,
			slug: provider.slug,
			status: provider.status
		})
		.from(provider)
		.orderBy(provider.name);
	const connections = await db
		.select({
			id: connection.id,
			providerId: connection.providerId,
			name: connection.name,
			slug: connection.slug,
			healthStatus: connection.healthStatus,
			enabled: connection.enabled
		})
		.from(connection)
		.orderBy(connection.name);

	// Observed traffic, last 24h, per provider and per connection.
	const providerTraffic = (await db.execute(sql`
		select provider_id, count(*)::int as requests,
		       count(*) filter (where status = 'success')::int as successes
		from request_log
		where created_at >= ${since}
		group by provider_id
	`)) as unknown as RawRow[];
	const connectionTraffic = (await db.execute(sql`
		select connection_id, count(*)::int as requests,
		       count(*) filter (where status = 'success')::int as successes
		from request_log
		where created_at >= ${since} and connection_id is not null
		group by connection_id
	`)) as unknown as RawRow[];
	const pTraffic = new Map(
		providerTraffic.map((r) => [String(r.provider_id), { requests: Number(r.requests), successes: Number(r.successes) }])
	);
	const cTraffic = new Map(
		connectionTraffic.map((r) => [
			String(r.connection_id),
			{ requests: Number(r.requests), successes: Number(r.successes) }
		])
	);

	// Open incidents, matched to a component by any of its names.
	const openIncidents = await db
		.select({
			id: incident.id,
			title: incident.title,
			component: incident.component,
			severity: incident.severity,
			status: incident.status,
			startedAt: incident.startedAt
		})
		.from(incident)
		.where(ne(incident.status, 'resolved'))
		.orderBy(desc(incident.startedAt));

	// Latest health snapshot per resource (health checks write
	// `provider.recovered`/`provider.degraded` rows on the connection).
	const snapshotRows = await db
		.select({
			type: systemEvent.type,
			resource: systemEvent.resource,
			resourceId: systemEvent.resourceId,
			createdAt: systemEvent.createdAt
		})
		.from(systemEvent)
		.where(sql`${systemEvent.type} like 'provider.%'`)
		.orderBy(desc(systemEvent.createdAt))
		.limit(500);
	const latestSnapshot = new Map<string, string>();
	for (const row of snapshotRows) {
		if (!row.resourceId || latestSnapshot.has(row.resourceId)) continue;
		latestSnapshot.set(row.resourceId, row.type === 'provider.recovered' ? 'healthy' : 'degraded');
	}

	const incidentsFor = (...names: string[]) =>
		openIncidents.filter((i) => names.includes(i.component));

	function healthOf(
		names: string[],
		traffic: { requests: number; successes: number } | undefined,
		snapshot: string | null
	): ComponentHealth {
		const requests = traffic?.requests ?? 0;
		const successRate =
			traffic && traffic.requests > 0 ? (100 * traffic.successes) / traffic.requests : null;
		return deriveHealth({
			requests,
			successRate,
			openIncidents: incidentsFor(...names),
			latestSnapshot: snapshot
		});
	}

	const components = providers.map((p) => {
		const pT = pTraffic.get(p.id);
		const names = [p.name, p.slug].filter((n): n is string => n !== null);
		return {
			id: p.id,
			name: p.name,
			slug: p.slug,
			health: healthOf(names, pT, latestSnapshot.get(p.id) ?? null),
			requests: pT?.requests ?? 0,
			successRate: pT && pT.requests > 0 ? (100 * pT.successes) / pT.requests : null,
			incidents: incidentsFor(...names),
			snapshot: latestSnapshot.get(p.id) ?? null,
			connections: connections
				.filter((c) => c.providerId === p.id)
				.map((c) => {
					const cT = cTraffic.get(c.id);
					return {
						id: c.id,
						name: c.name,
						slug: c.slug,
						enabled: c.enabled,
						healthStatus: c.healthStatus,
						health: healthOf([c.name, c.slug], cT, latestSnapshot.get(c.id) ?? null),
						requests: cT?.requests ?? 0,
						successRate: cT && cT.requests > 0 ? (100 * cT.successes) / cT.requests : null,
						incidents: incidentsFor(c.name, c.slug),
						snapshot: latestSnapshot.get(c.id) ?? null
					};
				})
		};
	});

	return { components };
};
