import { error, fail } from '@sveltejs/kit';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { assertPublicUpstream } from '$lib/server/ssrf';
import { writeAudit } from '$lib/server/audit';
import { newId, ID_PREFIXES } from '$lib/server/id';
import {
	CONNECTION_AUTH_TYPES,
	cleanField,
	parseBoolField,
	parseEnum,
	parseIntField,
	parseJsonField,
	parseSlugField
} from '$lib/server/admin-vocab';
import { MAX_PRIORITY, MIN_PRIORITY } from '$lib/server/admin-limits';
import { db } from '$lib/server/db';
import { connection, credential, provider } from '$lib/server/db/schema';

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 600_000;

export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.providers');
	const [p] = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.where(eq(provider.id, params.id))
		.limit(1);
	if (!p) error(404, 'Provider not found');
	const rows = await db
		.select({
			id: connection.id,
			name: connection.name,
			slug: connection.slug,
			baseUrl: connection.baseUrl,
			region: connection.region,
			authType: connection.authType,
			timeoutMs: connection.timeoutMs,
			priority: connection.priority,
			enabled: connection.enabled,
			healthStatus: connection.healthStatus,
			config: connection.config,
			createdAt: connection.createdAt,
			updatedAt: connection.updatedAt
		})
		.from(connection)
		.where(eq(connection.providerId, p.id))
		.orderBy(connection.priority, connection.name);
	const counts = await db
		.select({
			connectionId: credential.connectionId,
			n: sql<number>`count(*)::int`,
			healthy: sql<number>`count(*) filter (where ${credential.status} = 'healthy')::int`
		})
		.from(credential)
		.groupBy(credential.connectionId);
	const byConn = new Map(counts.map((c) => [c.connectionId, c]));
	return {
		provider: p,
		authTypes: CONNECTION_AUTH_TYPES,
		connections: rows.map((r) => ({
			...r,
			credentialCount: byConn.get(r.id)?.n ?? 0,
			credentialHealthy: byConn.get(r.id)?.healthy ?? 0
		}))
	};
};

export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const name = cleanField(form.get('name'));
		const slug = parseSlugField(form.get('slug'));
		const baseUrl = cleanField(form.get('baseUrl'), 2000);
		const region = form.get('region') ? cleanField(form.get('region')) : null;
		const authType = parseEnum(CONNECTION_AUTH_TYPES, form.get('authType'));
		const timeoutMs = parseIntField(form.get('timeoutMs'), {
			min: MIN_TIMEOUT_MS,
			max: MAX_TIMEOUT_MS
		});
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		const config = parseJsonField(form.get('config'));
		if (!name || !slug || !baseUrl || !authType || timeoutMs === null || priority === null) {
			return fail(400, {
				error: 'Name, slug, base URL, auth type, timeout and priority are all required'
			});
		}
		if (config === null) return fail(400, { error: 'Config must be a JSON object' });
		// base_url is admin-supplied and later fetched: a private or metadata
		// address would turn this form into a request-forgery primitive.
		const guard = await assertPublicUpstream(baseUrl);
		if (!guard.ok) return fail(400, { error: guard.reason });
		const [p] = await db
			.select({ id: provider.id })
			.from(provider)
			.where(eq(provider.id, params.id))
			.limit(1);
		if (!p) return fail(404, { error: 'Provider not found' });
		const [dup] = await db
			.select({ id: connection.id })
			.from(connection)
			.where(and(eq(connection.providerId, p.id), eq(connection.slug, slug)))
			.limit(1);
		if (dup) return fail(400, { error: 'A connection with this slug already exists' });
		const id = newId(ID_PREFIXES.connection);
		const after = {
			name,
			slug,
			baseUrl,
			region,
			authType,
			timeoutMs,
			priority,
			enabled: parseBoolField(form.get('enabled')),
			config
		};
		await db.transaction(async (tx) => {
			await tx.insert(connection).values({ id, providerId: p.id, ...after });
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'connection.create',
				resource: 'connection',
				resourceId: id,
				after
			});
		});
		return { created: name };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = cleanField(form.get('name'));
		const slug = parseSlugField(form.get('slug'));
		const baseUrl = cleanField(form.get('baseUrl'), 2000);
		const region = form.get('region') ? cleanField(form.get('region')) : null;
		const authType = parseEnum(CONNECTION_AUTH_TYPES, form.get('authType'));
		const timeoutMs = parseIntField(form.get('timeoutMs'), {
			min: MIN_TIMEOUT_MS,
			max: MAX_TIMEOUT_MS
		});
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		const config = parseJsonField(form.get('config'));
		if (!id) return fail(400, { error: 'Missing connection id' });
		if (!name || !slug || !baseUrl || !authType || timeoutMs === null || priority === null) {
			return fail(400, {
				error: 'Name, slug, base URL, auth type, timeout and priority are all required'
			});
		}
		if (config === null) return fail(400, { error: 'Config must be a JSON object' });
		const guard = await assertPublicUpstream(baseUrl);
		if (!guard.ok) return fail(400, { error: guard.reason });
		const [before] = await db.select().from(connection).where(eq(connection.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Connection not found' });
		const [dup] = await db
			.select({ id: connection.id })
			.from(connection)
			.where(
				and(
					eq(connection.providerId, before.providerId),
					eq(connection.slug, slug),
					ne(connection.id, id)
				)
			)
			.limit(1);
		if (dup) return fail(400, { error: 'A connection with this slug already exists' });
		const after = {
			name,
			slug,
			baseUrl,
			region,
			authType,
			timeoutMs,
			priority,
			enabled: parseBoolField(form.get('enabled')),
			config
		};
		await db.transaction(async (tx) => {
			await tx
				.update(connection)
				.set({ ...after, updatedAt: new Date() })
				.where(eq(connection.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'connection.update',
				resource: 'connection',
				resourceId: id,
				before: {
					name: before.name,
					slug: before.slug,
					baseUrl: before.baseUrl,
					region: before.region,
					authType: before.authType,
					timeoutMs: before.timeoutMs,
					priority: before.priority,
					enabled: before.enabled
				},
				after
			});
		});
		return { updated: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing connection id' });
		const [before] = await db
			.select({
				id: connection.id,
				name: connection.name,
				slug: connection.slug,
				providerId: connection.providerId
			})
			.from(connection)
			.where(eq(connection.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Connection not found' });
		await db.transaction(async (tx) => {
			await tx.delete(connection).where(eq(connection.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'connection.delete',
				resource: 'connection',
				resourceId: id,
				before
			});
		});
		return { deleted: id };
	}
};
