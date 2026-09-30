import { sql, type SQL } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';

type RawRow = Record<string, unknown>;

const WATCHED_TABLES = ['request_log', 'audit_log', 'job'] as const;

async function rowsOf(query: SQL): Promise<RawRow[]> {
	try {
		return (await db.execute(query)) as unknown as RawRow[];
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');

	// Connection count + what those connections are doing right now.
	const activity = await rowsOf(sql`
		select pid, state,
		       extract(epoch from (now() - query_start))::float8 as duration,
		       left(query, 120) as query
		from pg_stat_activity
		where backend_type = 'client backend'
		order by state nulls last, duration desc nulls last
	`);
	const active = activity.filter((r) => r.state === 'active');
	const slow = active.filter((r) => Number(r.duration ?? 0) > 1);

	// Size facts: database total, and the request_log hot spot.
	const sizeRows = await rowsOf(sql`
		select pg_size_pretty(pg_database_size(current_database())) as database_size,
		       (select count(*)::int from request_log) as request_log_rows,
		       pg_size_pretty(pg_total_relation_size('request_log')) as request_log_size
	`);
	const size = sizeRows[0];

	// Dead rows and autovacuum freshness for the three churn-heaviest tables.
	const bloat = await rowsOf(sql`
		select relname,
		       n_dead_tup::int as dead_rows,
		       last_autovacuum
		from pg_stat_user_tables
		where relname = any(${WATCHED_TABLES})
		order by n_dead_tup desc
	`);

	// Migration bookkeeping lives in `schema_migration` (scripts/migrate.sh).
	// The table predates the runners or may be absent on a database shaped by
	// drizzle-kit push — that is 'unknown', not a 500.
	let migration: { name: string; appliedAt: Date | string | null } | null = null;
	try {
		const rows = (await db.execute(sql`
			select name, applied_at from schema_migration order by applied_at desc nulls last limit 1
		`)) as unknown as RawRow[];
		const row = rows[0];
		if (row) migration = { name: String(row.name), appliedAt: (row.applied_at as Date) ?? null };
	} catch {
		migration = null;
	}

	return {
		connections: activity.map((r) => ({
			pid: Number(r.pid),
			state: r.state === null ? 'idle' : String(r.state),
			durationSeconds: Number(r.duration ?? 0),
			query: String(r.query ?? '')
		})),
		activeCount: active.length,
		slowQueries: slow.map((r) => ({
			pid: Number(r.pid),
			durationSeconds: Number(r.duration ?? 0),
			query: String(r.query ?? '')
		})),
		databaseSize: size ? String(size.database_size) : null,
		requestLogRows: size ? Number(size.request_log_rows) : null,
		requestLogSize: size ? String(size.request_log_size) : null,
		bloat: bloat.map((r) => ({
			table: String(r.relname),
			deadRows: Number(r.dead_rows ?? 0),
			lastAutovacuum: r.last_autovacuum ? String(r.last_autovacuum) : null
		})),
		migration
	};
};
