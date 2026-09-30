import { and, desc, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { cleanField, parseEnum } from '$lib/server/admin-vocab';

/** Statuses the queue may hold (job table defaults + worker transitions). */
const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
const RETRYABLE_STATUSES = ['failed', 'cancelled'] as const;
const CANCELLABLE_STATUSES = ['pending', 'running'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.ops');
	const status = parseEnum(JOB_STATUSES, url.searchParams.get('status'));
	const rawType = cleanField(url.searchParams.get('type'), 120);

	const filters = [
		status ? eq(job.status, status) : undefined,
		rawType ? eq(job.type, rawType) : undefined
	].filter((f): f is NonNullable<typeof f> => Boolean(f));

	const rows = await db
		.select({
			id: job.id,
			type: job.type,
			status: job.status,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			availableAt: job.availableAt,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			error: job.error,
			payload: job.payload,
			createdAt: job.createdAt
		})
		.from(job)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(job.createdAt))
		.limit(100);

	const types = await db.select({ type: job.type }).from(job).groupBy(job.type).orderBy(job.type);
	return {
		rows,
		types: types.map((t) => t.type),
		statuses: JOB_STATUSES,
		status: status ?? '',
		type: rawType ?? '',
		retryable: RETRYABLE_STATUSES,
		cancellable: CANCELLABLE_STATUSES
	};
};

export const actions: Actions = {
	retry: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing job id' });
		const outcome = await db.transaction(async (tx) => {
			const rows = await tx
				.select({
					id: job.id,
					type: job.type,
					status: job.status,
					attempts: job.attempts,
					error: job.error
				})
				.from(job)
				.where(eq(job.id, id))
				.limit(1);
			const row = rows[0];
			if (!row) return { kind: 'missing' as const };
			if (!(RETRYABLE_STATUSES as readonly string[]).includes(row.status)) {
				return { kind: 'conflict' as const };
			}
			await tx
				.update(job)
				.set({
					status: 'pending',
					attempts: 0,
					availableAt: new Date(),
					error: null,
					startedAt: null,
					finishedAt: null
				})
				.where(eq(job.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'job.retry',
				resource: 'job',
				resourceId: row.id,
				before: { status: row.status, attempts: row.attempts, error: row.error },
				after: { status: 'pending', attempts: 0, error: null }
			});
			return { kind: 'ok' as const, id: row.id };
		});
		if (outcome.kind === 'missing') return fail(404, { error: 'Job not found' });
		if (outcome.kind === 'conflict') {
			return fail(409, { error: 'Job not in a retryable state (failed/cancelled)' });
		}
		return { retried: outcome.id };
	},
	cancel: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing job id' });
		const outcome = await db.transaction(async (tx) => {
			const rows = await tx
				.select({ id: job.id, status: job.status, attempts: job.attempts })
				.from(job)
				.where(eq(job.id, id))
				.limit(1);
			const row = rows[0];
			if (!row) return { kind: 'missing' as const };
			if (!(CANCELLABLE_STATUSES as readonly string[]).includes(row.status)) {
				return { kind: 'conflict' as const };
			}
			await tx
				.update(job)
				.set({ status: 'cancelled', finishedAt: new Date() })
				.where(eq(job.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'job.cancel',
				resource: 'job',
				resourceId: row.id,
				before: { status: row.status, attempts: row.attempts },
				after: { status: 'cancelled' }
			});
			return { kind: 'ok' as const, id: row.id };
		});
		if (outcome.kind === 'missing') return fail(404, { error: 'Job not found' });
		if (outcome.kind === 'conflict') {
			return fail(409, { error: 'Job not cancellable (pending/running only)' });
		}
		return { cancelled: outcome.id };
	}
};
