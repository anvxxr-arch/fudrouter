import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { circuitBreaker, connection, model, provider } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { getJSON } from '$lib/server/vk';
import { CIRCUIT_TARGETS, parseBoolField, parseEnum, parseIntField } from '$lib/server/admin-vocab';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const rows = await db.select().from(circuitBreaker).orderBy(circuitBreaker.target, circuitBreaker.targetId);
	const [providers, connections, models] = await Promise.all([
		db.select({ id: provider.id, name: provider.name }).from(provider).orderBy(provider.name),
		db
			.select({ id: connection.id, name: connection.name, providerId: connection.providerId })
			.from(connection)
			.orderBy(connection.name),
		db.select({ id: model.id, name: model.name, slug: model.slug }).from(model).orderBy(model.slug)
	]);
	// Runtime breaker state is Valkey-only and may vanish (spec §12) — best
	// effort, one read per row; anything unreadable shows as 'closed (or unavailable)'.
	const state = await Promise.all(
		rows.map((r) => getJSON(`circuit:${r.target}:${r.targetId}`).catch(() => null))
	);
	return {
		breakers: rows.map((r, i) => ({
			...r,
			state: state[i] === null ? 'closed (or unavailable)' : JSON.stringify(state[i])
		})),
		providers,
		connections,
		models,
		targets: CIRCUIT_TARGETS as readonly string[]
	};
};

interface TargetPick {
	target: (typeof CIRCUIT_TARGETS)[number];
	targetId: string;
}

/** The target_id must name a real row of the picked target type. */
async function resolveTarget(form: FormData): Promise<TargetPick | null> {
	const target = parseEnum(CIRCUIT_TARGETS, form.get('target'));
	const targetId = String(form.get('targetId') ?? '').trim();
	if (!target || !targetId) return null;
	if (target === 'provider') {
		const [row] = await db.select({ id: provider.id }).from(provider).where(eq(provider.id, targetId)).limit(1);
		return row ? { target, targetId: row.id } : null;
	}
	if (target === 'connection') {
		const [row] = await db
			.select({ id: connection.id })
			.from(connection)
			.where(eq(connection.id, targetId))
			.limit(1);
		return row ? { target, targetId: row.id } : null;
	}
	const [row] = await db.select({ id: model.id }).from(model).where(eq(model.id, targetId)).limit(1);
	return row ? { target, targetId: row.id } : null;
}

/** The editable fields of a `circuit_breaker` row, already validated. */
interface BreakerPatch {
	failureThreshold: number;
	windowSeconds: number;
	openMs: number;
	halfOpenProbes: number;
	enabled: boolean;
}

function breakerValues(form: FormData): { values: BreakerPatch } | { error: string } {
	const failureThreshold = parseIntField(form.get('failureThreshold'), { min: 1, max: 1000 });
	if (failureThreshold === null) return { error: 'failure_threshold must be 1–1000' };
	const windowSeconds = parseIntField(form.get('windowSeconds'), { min: 1, max: 86_400 });
	if (windowSeconds === null) return { error: 'window_seconds must be 1–86400' };
	const openMs = parseIntField(form.get('openMs'), { min: 1, max: 86_400_000 });
	if (openMs === null) return { error: 'open_ms must be 1–86400000' };
	const halfOpenProbes = parseIntField(form.get('halfOpenProbes'), { min: 1, max: 100 });
	if (halfOpenProbes === null) return { error: 'half_open_probes must be 1–100' };
	return {
		values: {
			failureThreshold,
			windowSeconds,
			openMs,
			halfOpenProbes,
			enabled: parseBoolField(form.get('enabled'))
		}
	};
}

function slim(p: Record<string, unknown>): Record<string, unknown> {
	return {
		id: p.id,
		target: p.target,
		targetId: p.targetId,
		failureThreshold: p.failureThreshold,
		windowSeconds: p.windowSeconds,
		openMs: p.openMs,
		halfOpenProbes: p.halfOpenProbes,
		enabled: p.enabled
	};
}

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const pick = await resolveTarget(form);
		if (!pick) return fail(400, { error: 'Pick a valid target and target id' });
		const parsed = breakerValues(form);
		if ('error' in parsed) return fail(400, parsed);
		const id = newId(ID_PREFIXES.circuitBreaker);
		const row: typeof circuitBreaker.$inferInsert = { id, ...pick, ...parsed.values };
		// Unique (target, target_id): a duplicate must be a message, not a 500.
		const [existing] = await db
			.select({ id: circuitBreaker.id })
			.from(circuitBreaker)
			.where(and(eq(circuitBreaker.target, pick.target), eq(circuitBreaker.targetId, pick.targetId)))
			.limit(1);
		if (existing) {
			return fail(400, {
				error: `A circuit breaker for ${pick.target} ${pick.targetId} already exists`
			});
		}
		try {
			await db.transaction(async (tx) => {
				await tx.insert(circuitBreaker).values(row);
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'circuit_breaker.create',
					resource: 'circuit_breaker',
					resourceId: id,
					before: null,
					after: slim(row as Record<string, unknown>)
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			// Backstop: two concurrent creates can both pass the pre-check.
			if (/circuit_breaker_target_idx|duplicate key|unique/i.test(msg)) {
				return fail(400, {
					error: `A circuit breaker for ${pick.target} ${pick.targetId} already exists`
				});
			}
			return fail(400, { error: `Could not create circuit breaker: ${msg}` });
		}
		return { created: `${pick.target}: ${pick.targetId}` };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing circuit breaker id' });
		const parsed = breakerValues(form);
		if ('error' in parsed) return fail(400, parsed);
		const patch: Partial<typeof circuitBreaker.$inferInsert> = { ...parsed.values };
		try {
			const found = await db.transaction(async (tx) => {
				const [before] = await tx
					.select()
					.from(circuitBreaker)
					.where(eq(circuitBreaker.id, id))
					.limit(1);
				if (!before) return false;
				await tx.update(circuitBreaker).set(patch).where(eq(circuitBreaker.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'circuit_breaker.update',
					resource: 'circuit_breaker',
					resourceId: id,
					before: slim(before as unknown as Record<string, unknown>),
					after: slim({ ...before, ...patch })
				});
				return true;
			});
			if (!found) return fail(404, { error: 'Circuit breaker not found' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'update failed';
			return fail(400, { error: `Could not update circuit breaker: ${msg}` });
		}
		return { updated: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing circuit breaker id' });
		try {
			const deleted = await db.transaction(async (tx) => {
				const [before] = await tx
					.select()
					.from(circuitBreaker)
					.where(eq(circuitBreaker.id, id))
					.limit(1);
				if (!before) return false;
				await tx.delete(circuitBreaker).where(eq(circuitBreaker.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'circuit_breaker.delete',
					resource: 'circuit_breaker',
					resourceId: id,
					before: slim(before as unknown as Record<string, unknown>),
					after: null
				});
				return true;
			});
			if (!deleted) return fail(404, { error: 'Circuit breaker not found' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'delete failed';
			return fail(400, { error: `Could not delete circuit breaker: ${msg}` });
		}
		return { deleted: id };
	}
};
