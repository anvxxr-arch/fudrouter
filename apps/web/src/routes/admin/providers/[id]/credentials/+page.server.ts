import { error, fail, type ActionFailure } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { encryptCredentials } from '$lib/server/credentials';
import {
	credentialForDisplay,
	credentialPool,
	secretShownOnce
} from '$lib/server/admin-credentials';
import { writeAudit } from '$lib/server/audit';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { parseHeaderLines } from '$lib/server/admin';
import {
	CREDENTIAL_STATUSES,
	cleanField,
	parseIntField,
	parseJsonField
} from '$lib/server/admin-vocab';
import { MAX_PRIORITY, MIN_PRIORITY } from '$lib/server/admin-limits';
import { db } from '$lib/server/db';
import { connection, credential, provider } from '$lib/server/db/schema';

const MIN_WEIGHT = 0;
const MAX_WEIGHT = 10_000;
/** Last-used ages offered in the filter dropdown (hours). */
const LAST_USED_AGES = ['1', '24', '168', '720'] as const;

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requireCap(locals, 'admin.providers');
	const [p] = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.where(eq(provider.id, params.id))
		.limit(1);
	if (!p) error(404, 'Provider not found');
	const conns = await db
		.select({ id: connection.id, name: connection.name, slug: connection.slug })
		.from(connection)
		.where(eq(connection.providerId, p.id))
		.orderBy(connection.priority, connection.name);
	const connName = new Map(conns.map((c) => [c.id, c.name]));

	// Filters (a form GET, so the query string is the filter state).
	const filterConnection = url.searchParams.get('connection') ?? '';
	const filterStatus = url.searchParams.get('status') ?? '';
	const filterLastUsed = url.searchParams.get('lastUsed') ?? '';
	const where = [
		filterConnection ? eq(credential.connectionId, filterConnection) : sql`true`,
		filterStatus ? eq(credential.status, filterStatus) : sql`true`,
		filterLastUsed
			? sql`${credential.lastUsedAt} > now() - (${Number(filterLastUsed)} || ' hours')::interval`
			: sql`true`
	];

	// Pool summary covers every credential of this provider, not just the filtered
	// rows: the counters answer "how healthy is the pool", the table answers "which".
	const poolRows = await db
		.select({ status: credential.status })
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.where(eq(connection.providerId, p.id));

	// Never select `secretEnc`: the page's load columns are the proof that no
	// secret material can leave the server on a reload.
	const rows = await db
		.select({
			id: credential.id,
			connectionId: credential.connectionId,
			name: credential.name,
			status: credential.status,
			priority: credential.priority,
			weight: credential.weight,
			lastUsedAt: credential.lastUsedAt,
			lastSuccessAt: credential.lastSuccessAt,
			lastErrorAt: credential.lastErrorAt,
			cooldownUntil: credential.cooldownUntil,
			metadata: credential.metadata,
			createdAt: credential.createdAt,
			updatedAt: credential.updatedAt
		})
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.where(and(eq(connection.providerId, p.id), ...where))
		.orderBy(credential.priority, credential.name);

	return {
		provider: p,
		connections: conns,
		statuses: CREDENTIAL_STATUSES,
		lastUsedAges: LAST_USED_AGES,
		filters: {
			connection: filterConnection,
			status: filterStatus,
			lastUsed: filterLastUsed
		},
		// `credentialForDisplay` on a column projection that carries no ciphertext
		// at all — belt and braces, so a later column addition cannot leak one.
		credentials: rows.map((r) => ({
			...credentialForDisplay(r),
			connectionName: connName.get(r.connectionId) ?? '—'
		})),
		pool: credentialPool(poolRows)
	};
};

/** The plaintext payload stored (encrypted) for one credential. */
function secretBlob(apiKey: string, headersText: string): string {
	const headers = parseHeaderLines(headersText);
	const payload: Record<string, unknown> = { api_key: apiKey };
	if (Object.keys(headers).length > 0) payload.default_headers = headers;
	return encryptCredentials(payload);
}

export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const name = cleanField(form.get('name'));
		const secret = String(form.get('secret') ?? '').trim();
		const headers = String(form.get('headers') ?? '');
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		const weight = parseIntField(form.get('weight'), { min: MIN_WEIGHT, max: MAX_WEIGHT });
		const metadata = parseJsonField(form.get('metadata'));
		const connectionId = String(form.get('connectionId') ?? '').trim();
		if (!name || !secret || !connectionId || priority === null || weight === null) {
			return fail(400, { error: 'Name, connection, secret, priority and weight are all required' });
		}
		if (metadata === null) return fail(400, { error: 'Metadata must be a JSON object' });
		const [conn] = await db
			.select({ id: connection.id })
			.from(connection)
			.innerJoin(provider, eq(provider.id, connection.providerId))
			.where(and(eq(provider.id, params.id), eq(connection.id, connectionId)))
			.limit(1);
		if (!conn) return fail(404, { error: 'Connection not found on this provider' });
		const id = newId(ID_PREFIXES.credential);
		await db.transaction(async (tx) => {
			await tx.insert(credential).values({
				id,
				connectionId: conn.id,
				name,
				secretEnc: secretBlob(secret, headers),
				status: 'unknown',
				priority,
				weight,
				metadata
			});
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'credential.create',
				resource: 'credential',
				resourceId: id,
				after: { name, connectionId: conn.id, priority, weight, metadata }
			});
		});
		// The ONE shape that ever carries plaintext, minted here and never re-readable.
		return { created: true, secretOnce: secretShownOnce(id, name, secret) };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = cleanField(form.get('name'));
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		const weight = parseIntField(form.get('weight'), { min: MIN_WEIGHT, max: MAX_WEIGHT });
		const metadata = parseJsonField(form.get('metadata'));
		const status = String(form.get('status') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing credential id' });
		if (!name || priority === null || weight === null) {
			return fail(400, { error: 'Name, priority and weight are all required' });
		}
		if (metadata === null) return fail(400, { error: 'Metadata must be a JSON object' });
		// The secret is never part of an edit: rotation is its own confirmed action.
		const patch: Record<string, unknown> = { name, priority, weight, metadata };
		if (status) {
			if (!(CREDENTIAL_STATUSES as readonly string[]).includes(status)) {
				return fail(400, { error: 'Invalid status' });
			}
			patch.status = status;
		}
		const [before] = await db.select().from(credential).where(eq(credential.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Credential not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(credential)
				.set({ ...patch, updatedAt: new Date() })
				.where(eq(credential.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'credential.update',
				resource: 'credential',
				resourceId: id,
				before: {
					name: before.name,
					priority: before.priority,
					weight: before.weight,
					status: before.status,
					metadata: before.metadata
				},
				after: { name, priority, weight, metadata, ...(status ? { status } : {}) }
			});
		});
		return { updated: id };
	},
	disable: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		return setStatus(locals, request, 'disabled', 'credential.disable');
	},
	enable: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		return setStatus(locals, request, 'unknown', 'credential.enable');
	},
	rotate: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const secret = String(form.get('secret') ?? '').trim();
		const headers = String(form.get('headers') ?? '');
		if (!id) return fail(400, { error: 'Missing credential id' });
		if (!secret) return fail(400, { error: 'A rotation needs the new secret' });
		if (!confirmed(form)) return fail(400, { error: 'Tick the confirmation box to rotate' });
		const [before] = await db
			.select({ id: credential.id, name: credential.name, status: credential.status })
			.from(credential)
			.where(eq(credential.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Credential not found' });
		await db.transaction(async (tx) => {
			// A rotated secret is unproven until it succeeds once, and its old
			// cooldown says nothing about the new key.
			await tx
				.update(credential)
				.set({
					secretEnc: secretBlob(secret, headers),
					status: 'unknown',
					cooldownUntil: null,
					updatedAt: new Date()
				})
				.where(eq(credential.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'credential.rotate',
				resource: 'credential',
				resourceId: id,
				// No secret material in before/after — only the fact of rotation.
				before: { status: before.status },
				after: { status: 'unknown', cooldownUntil: null }
			});
		});
		return { rotated: true, secretOnce: secretShownOnce(id, before.name, secret) };
	},
	revoke: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing credential id' });
		if (!confirmed(form)) return fail(400, { error: 'Tick the confirmation box to revoke' });
		const [before] = await db
			.select({ id: credential.id, status: credential.status, cooldownUntil: credential.cooldownUntil })
			.from(credential)
			.where(eq(credential.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Credential not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(credential)
				.set({ status: 'invalid', cooldownUntil: null, updatedAt: new Date() })
				.where(eq(credential.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'credential.revoke',
				resource: 'credential',
				resourceId: id,
				before: { status: before.status },
				after: { status: 'invalid', cooldownUntil: null }
			});
		});
		return { revoked: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing credential id' });
		if (!confirmed(form)) return fail(400, { error: 'Tick the confirmation box to delete' });
		const [before] = await db
			.select({
				id: credential.id,
				name: credential.name,
				connectionId: credential.connectionId,
				status: credential.status
			})
			.from(credential)
			.where(eq(credential.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Credential not found' });
		await db.transaction(async (tx) => {
			await tx.delete(credential).where(eq(credential.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'credential.delete',
				resource: 'credential',
				resourceId: id,
				before
			});
		});
		return { deleted: id };
	}
};

/** A destructive/secret-replacing action must be confirmed in the form itself. */
function confirmed(form: FormData): boolean {
	return String(form.get('confirm') ?? '').toLowerCase() === 'on';
}

/** Outcome of one status flip: a message on success, a form failure otherwise. */
type StatusOutcome = { message: string } | ActionFailure<{ error: string }>;

/** Flip one credential's status, with the same confirm + audit shape everywhere. */
async function setStatus(
	locals: App.Locals,
	request: Request,
	status: string,
	action: string
): Promise<StatusOutcome> {
	const form = await request.formData();
	const id = String(form.get('id') ?? '').trim();
	if (!id) return fail(400, { error: 'Missing credential id' });
	if (!confirmed(form)) return fail(400, { error: 'Tick the confirmation box to continue' });
	const [before] = await db
		.select({ id: credential.id, name: credential.name, status: credential.status })
		.from(credential)
		.where(eq(credential.id, id))
		.limit(1);
	if (!before) return fail(404, { error: 'Credential not found' });
	await db.transaction(async (tx) => {
		await tx
			.update(credential)
			.set({ status, updatedAt: new Date() })
			.where(eq(credential.id, id));
		await writeAudit(tx, {
			actorUserId: locals.user?.id ?? null,
			action,
			resource: 'credential',
			resourceId: id,
			before: { status: before.status },
			after: { status }
		});
	});
	return { message: `${before.name} → ${status}` };
}
