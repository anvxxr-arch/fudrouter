import { fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { newId, ID_PREFIXES } from '$lib/server/id';
import {
	PROVIDER_STATUSES,
	PROVIDER_TIERS,
	cleanField,
	parseBoolField,
	parseEnum,
	parseIntField,
	parseSlugField
} from '$lib/server/admin-vocab';
import { MAX_PRIORITY, MIN_PRIORITY } from '$lib/server/admin-limits';
import { db } from '$lib/server/db';
import { connection, credential, model, provider } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.providers');
	// Never select credentials_enc: the ciphertext must not leave the server.
	const rows = await db
		.select({
			id: provider.id,
			name: provider.name,
			slug: provider.slug,
			description: provider.description,
			type: provider.type,
			status: provider.status,
			tier: provider.tier,
			homepage: provider.homepage,
			documentationUrl: provider.documentationUrl,
			enabled: provider.enabled,
			priority: provider.priority,
			createdAt: provider.createdAt
		})
		.from(provider)
		.orderBy(provider.priority, provider.name);
	const modelCounts = await db
		.select({ providerId: model.providerId, n: sql<number>`count(*)::int` })
		.from(model)
		.groupBy(model.providerId);
	const byProvider = new Map(modelCounts.map((c) => [c.providerId, c.n]));
	const connCounts = await db
		.select({ providerId: connection.providerId, n: sql<number>`count(*)::int` })
		.from(connection)
		.groupBy(connection.providerId);
	const byConn = new Map(connCounts.map((c) => [c.providerId, c]));
	// Credential health rolls up through connection: healthy/total per provider.
	const credHealth = await db
		.select({
			providerId: connection.providerId,
			total: sql<number>`count(*)::int`,
			healthy: sql<number>`count(*) filter (where ${credential.status} = 'healthy')::int`,
			unknown: sql<number>`count(*) filter (where ${credential.status} = 'unknown')::int`,
			bad: sql<number>`count(*) filter (where ${credential.status} in ('auth_failed', 'invalid'))::int`
		})
		.from(credential)
		.innerJoin(connection, eq(connection.id, credential.connectionId))
		.groupBy(connection.providerId);
	const byHealth = new Map(credHealth.map((c) => [c.providerId, c]));
	const models = await db
		.select({
			id: model.id,
			providerId: model.providerId,
			slug: model.slug,
			status: model.status
		})
		.from(model)
		.orderBy(model.slug);
	return {
		providers: rows.map((r) => ({
			...r,
			modelCount: byProvider.get(r.id) ?? 0,
			connectionCount: byConn.get(r.id) ?? 0,
			credentials: {
				total: byHealth.get(r.id)?.total ?? 0,
				healthy: byHealth.get(r.id)?.healthy ?? 0,
				unknown: byHealth.get(r.id)?.unknown ?? 0,
				bad: byHealth.get(r.id)?.bad ?? 0
			}
		})),
		models,
		statuses: PROVIDER_STATUSES,
		tiers: PROVIDER_TIERS
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const name = cleanField(form.get('name'));
		const slug = parseSlugField(form.get('slug'));
		const description = form.get('description') ? cleanField(form.get('description'), 2000) : null;
		const type = form.get('type') ? cleanField(form.get('type')) : null;
		const status = parseEnum(PROVIDER_STATUSES, form.get('status'));
		const tier = parseEnum(PROVIDER_TIERS, form.get('tier'));
		const homepage = form.get('homepage') ? cleanField(form.get('homepage'), 2000) : null;
		const documentationUrl = form.get('documentationUrl')
			? cleanField(form.get('documentationUrl'), 2000)
			: null;
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		if (!name || !slug || !status || !tier || priority === null) {
			return fail(400, { error: 'Name, slug, status, tier and priority are all required' });
		}
		if (homepage !== null && !/^https?:\/\//.test(homepage)) {
			return fail(400, { error: 'Homepage must be an http(s) URL' });
		}
		if (documentationUrl !== null && !/^https?:\/\//.test(documentationUrl)) {
			return fail(400, { error: 'Documentation URL must be an http(s) URL' });
		}
		const [dup] = await db
			.select({ id: provider.id })
			.from(provider)
			.where(eq(provider.slug, slug))
			.limit(1);
		if (dup) return fail(400, { error: 'A provider with this slug already exists' });
		const id = newId(ID_PREFIXES.provider);
		const after = {
			name,
			slug,
			description,
			type,
			status,
			tier,
			homepage,
			documentationUrl,
			enabled: parseBoolField(form.get('enabled')),
			priority
		};
		await db.transaction(async (tx) => {
			await tx.insert(provider).values({
				id,
				...after,
				// Legacy S0 columns, NOT NULL: real endpoints and credentials live on
				// the connection/credential rows now. Empty, never fabricated.
				baseUrl: '',
				credentialsEnc: ''
			});
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'provider.create',
				resource: 'provider',
				resourceId: id,
				after
			});
		});
		return { created: name };
	},
	// Update metadata only — connections and credentials own endpoints and secrets.
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.providers');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = cleanField(form.get('name'));
		const slug = parseSlugField(form.get('slug'));
		const description = form.get('description') ? cleanField(form.get('description'), 2000) : null;
		const type = form.get('type') ? cleanField(form.get('type')) : null;
		const status = parseEnum(PROVIDER_STATUSES, form.get('status'));
		const tier = parseEnum(PROVIDER_TIERS, form.get('tier'));
		const homepage = form.get('homepage') ? cleanField(form.get('homepage'), 2000) : null;
		const documentationUrl = form.get('documentationUrl')
			? cleanField(form.get('documentationUrl'), 2000)
			: null;
		const priority = parseIntField(form.get('priority'), { min: MIN_PRIORITY, max: MAX_PRIORITY });
		if (!id) return fail(400, { error: 'Missing provider id' });
		if (!name || !slug || !status || !tier || priority === null) {
			return fail(400, { error: 'Name, slug, status, tier and priority are all required' });
		}
		const [dup] = await db
			.select({ id: provider.id })
			.from(provider)
			.where(eq(provider.slug, slug))
			.limit(1);
		if (dup && dup.id !== id) return fail(400, { error: 'A provider with this slug already exists' });
		const [before] = await db.select().from(provider).where(eq(provider.id, id)).limit(1);
		if (!before) return fail(404, { error: 'Provider not found' });
		const after = {
			name,
			slug,
			description,
			type,
			status,
			tier,
			homepage,
			documentationUrl,
			enabled: parseBoolField(form.get('enabled')),
			priority
		};
		await db.transaction(async (tx) => {
			await tx
				.update(provider)
				.set({ ...after, updatedAt: new Date() })
				.where(eq(provider.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'provider.update',
				resource: 'provider',
				resourceId: id,
				before: {
					name: before.name,
					slug: before.slug,
					description: before.description,
					type: before.type,
					status: before.status,
					tier: before.tier,
					homepage: before.homepage,
					documentationUrl: before.documentationUrl,
					enabled: before.enabled,
					priority: before.priority
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
		if (!id) return fail(400, { error: 'Missing provider id' });
		const [before] = await db
			.select({ id: provider.id, name: provider.name, slug: provider.slug })
			.from(provider)
			.where(eq(provider.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Provider not found' });
		try {
			await db.transaction(async (tx) => {
				await tx.delete(provider).where(eq(provider.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'provider.delete',
					resource: 'provider',
					resourceId: id,
					before
				});
			});
		} catch {
			// request_log.provider_id has no cascade: a referenced provider is kept.
			return fail(409, { error: 'Provider has request history — disable it instead' });
		}
		return { deleted: id };
	}
};
