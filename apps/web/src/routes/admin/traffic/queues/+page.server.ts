import { gte, inArray, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { job, requestLog } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
// Queues (PRD §75): PostgreSQL is the durable job queue (workers claim with
// SKIP LOCKED), so the pending/running rows here ARE the backlog. Read-only —
// retry and cancel live under /admin/system/jobs.
const LIVE_STATUSES = ['pending', 'running'];
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const counts = await db
		.select({ status: job.status, type: job.type, n: sql<number>`count(*)::int` })
		.from(job)
		.groupBy(job.status, job.type);
	const live = await db
		.select({
			id: job.id,
			type: job.type,
			status: job.status,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			availableAt: job.availableAt,
			error: job.error
		})
		.from(job)
		.where(inArray(job.status, LIVE_STATUSES))
		.orderBy(job.availableAt)
		.limit(100);
	// "In flight" proxy the request log can answer honestly: calls accepted in
	// the last 60 seconds (the durable log has no finished flag).
	const [recent] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(requestLog)
		.where(gte(requestLog.createdAt, new Date(Date.now() - 60_000)));
	return {
		counts,
		live: live.map((j) => ({ ...j, availableAt: j.availableAt.toISOString() })),
		inFlightLastMinute: recent?.n ?? 0
	};
};
