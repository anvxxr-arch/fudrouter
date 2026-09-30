import { asc, desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	// Queue shape: how the backlog is distributed across types and statuses.
	const groups = await db
		.select({ status: job.status, type: job.type, n: sql<number>`count(*)::int` })
		.from(job)
		.groupBy(job.status, job.type)
		.orderBy(asc(job.status), asc(job.type));

	// The running rows get detail: this is what the workers hold right now.
	const running = await db
		.select({
			id: job.id,
			type: job.type,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			startedAt: job.startedAt,
			availableAt: job.availableAt,
			createdAt: job.createdAt
		})
		.from(job)
		.where(eq(job.status, 'running'))
		.orderBy(desc(job.startedAt))
		.limit(50);

	return { groups, running };
};
