import { desc, ne, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { incident, job, systemEvent } from '$lib/server/db/schema';
import { vk } from '$lib/server/vk';

type RawRow = Record<string, unknown>;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	// PostgreSQL summary. Fails soft: a stats query that cannot run must not
	// take the whole hub down — the database drill-down explains what is wrong.
	let database: { size: string; connections: number } | null = null;
	try {
		const rows = (await db.execute(sql`
			select pg_size_pretty(pg_database_size(current_database())) as size,
			       (select count(*)::int from pg_stat_activity) as connections
		`)) as unknown as RawRow[];
		const row = rows[0];
		if (row) database = { size: String(row.size), connections: Number(row.connections) };
	} catch {
		database = null;
	}

	// Valkey: 'up' only when a PING actually answers — configured is not the
	// same as reachable.
	let valkey: 'up' | 'down' | 'not configured' = 'not configured';
	const client = vk();
	if (client) {
		try {
			await client.ping();
			valkey = 'up';
		} catch {
			valkey = 'down';
		}
	}

	// Job backlog: everything a worker still owes us.
	const jobCounts = await db
		.select({ status: job.status, n: sql<number>`count(*)::int` })
		.from(job)
		.groupBy(job.status);
	const backlog = jobCounts.reduce(
		(sum, j) => (j.status === 'pending' || j.status === 'running' ? sum + j.n : sum),
		0
	);

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

	const events = await db
		.select({
			id: systemEvent.id,
			type: systemEvent.type,
			resource: systemEvent.resource,
			resourceId: systemEvent.resourceId,
			metadata: systemEvent.metadata,
			createdAt: systemEvent.createdAt
		})
		.from(systemEvent)
		.orderBy(desc(systemEvent.createdAt))
		.limit(20);

	return { database, valkey, backlog, jobCounts, openIncidents, events };
};
