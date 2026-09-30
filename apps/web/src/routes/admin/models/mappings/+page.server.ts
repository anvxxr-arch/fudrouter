import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { connection, model, provider, providerModel } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';
import {
	PROVIDER_MODEL_STATUSES,
	parseIntField,
	parseBoolField,
	parseEnum,
	parseFlagsField,
	parseSlugField
} from '$lib/server/admin-vocab';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.models');
	const rows = await db
		.select({
			id: providerModel.id,
			modelId: providerModel.modelId,
			providerId: providerModel.providerId,
			connectionId: providerModel.connectionId,
			providerModelId: providerModel.providerModelId,
			enabled: providerModel.enabled,
			capabilitiesOverride: providerModel.capabilitiesOverride,
			contextOverride: providerModel.contextOverride,
			status: providerModel.status,
			modelSlug: model.slug,
			providerName: provider.name,
			connectionName: connection.name
		})
		.from(providerModel)
		.innerJoin(model, eq(model.id, providerModel.modelId))
		.innerJoin(provider, eq(provider.id, providerModel.providerId))
		.leftJoin(connection, eq(connection.id, providerModel.connectionId))
		.orderBy(asc(model.slug), asc(provider.name));
	const models = await db
		.select({ id: model.id, slug: model.slug, name: model.name })
		.from(model)
		.orderBy(asc(model.slug));
	const providers = await db
		.select({ id: provider.id, name: provider.name })
		.from(provider)
		.orderBy(asc(provider.name));
	// Connections are picked per provider in the form, so carry providerId along.
	const connections = await db
		.select({
			id: connection.id,
			providerId: connection.providerId,
			name: connection.name,
			region: connection.region
		})
		.from(connection)
		.orderBy(asc(connection.name));
	return {
		rows,
		models,
		providers,
		connections,
		statuses: PROVIDER_MODEL_STATUSES
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const modelId = String(form.get('modelId') ?? '').trim();
		const providerId = String(form.get('providerId') ?? '').trim();
		const connectionRaw = String(form.get('connectionId') ?? '').trim();
		const providerModelId = parseSlugField(form.get('providerModelId'));
		const enabled = parseBoolField(form.get('enabled'));
		const capabilitiesOverride = parseFlagsField(form.get('capabilitiesOverride'));
		const contextOverride = parseIntField(form.get('contextOverride'), { min: 1, max: 100_000_000 });
		const rawContext = String(form.get('contextOverride') ?? '').trim();
		if (!modelId || !providerId) return fail(400, { error: 'Model and provider required' });
		if (!providerModelId) return fail(400, { error: 'Upstream model id required' });
		if (capabilitiesOverride === null)
			return fail(400, { error: 'Capabilities override must be a JSON flags object' });
		// Empty clears the override; anything in the box must have parsed.
		if (rawContext && contextOverride === null)
			return fail(400, { error: 'Context override must be a positive integer' });
		const [modelRow] = await db
			.select({ id: model.id })
			.from(model)
			.where(eq(model.id, modelId))
			.limit(1);
		if (!modelRow) return fail(400, { error: 'Unknown model' });
		let connectionId: string | null = null;
		if (connectionRaw) {
			const [conn] = await db
				.select({ id: connection.id })
				.from(connection)
				.where(eq(connection.id, connectionRaw))
				.limit(1);
			if (!conn) return fail(400, { error: 'Unknown connection' });
			connectionId = conn.id;
		}
		const id = newId(ID_PREFIXES.providerModel);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(providerModel).values({
					id,
					modelId,
					providerId,
					connectionId,
					providerModelId,
					enabled,
					capabilitiesOverride,
					contextOverride: contextOverride ?? null,
					status: 'available'
				});
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'provider_model.create',
					resource: 'provider_model',
					resourceId: id,
					after: {
						modelId,
						providerId,
						connectionId,
						providerModelId,
						enabled,
						capabilitiesOverride,
						contextOverride: contextOverride ?? null,
						status: 'available'
					}
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'insert failed';
			return fail(409, { error: `Could not create mapping: ${msg}` });
		}
		return { created: id, message: `Mapping “${providerModelId}” created.` };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const providerModelId = parseSlugField(form.get('providerModelId'));
		const enabled = parseBoolField(form.get('enabled'));
		const capabilitiesOverride = parseFlagsField(form.get('capabilitiesOverride'));
		const contextOverride = parseIntField(form.get('contextOverride'), { min: 1, max: 100_000_000 });
		const rawContext = String(form.get('contextOverride') ?? '').trim();
		const status = parseEnum(PROVIDER_MODEL_STATUSES, form.get('status'));
		const connectionRaw = String(form.get('connectionId') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing mapping id' });
		if (!providerModelId) return fail(400, { error: 'Upstream model id required' });
		if (capabilitiesOverride === null)
			return fail(400, { error: 'Capabilities override must be a JSON flags object' });
		if (rawContext && contextOverride === null)
			return fail(400, { error: 'Context override must be a positive integer' });
		if (!status) return fail(400, { error: 'Invalid status' });
		const [before] = await db
			.select()
			.from(providerModel)
			.where(eq(providerModel.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Mapping not found' });
		let connectionId: string | null = null;
		if (connectionRaw) {
			const [conn] = await db
				.select({ id: connection.id, providerId: connection.providerId })
				.from(connection)
				.where(eq(connection.id, connectionRaw))
				.limit(1);
			// The connection must belong to the mapping's provider.
			if (!conn || conn.providerId !== before.providerId)
				return fail(400, { error: 'Connection does not belong to this mapping’s provider' });
			connectionId = conn.id;
		}
		const after = {
			providerModelId,
			connectionId,
			enabled,
			capabilitiesOverride,
			contextOverride: contextOverride ?? null,
			status
		};
		try {
			await db.transaction(async (tx) => {
				await tx
					.update(providerModel)
					.set({ ...after, updatedAt: new Date() })
					.where(eq(providerModel.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'provider_model.update',
					resource: 'provider_model',
					resourceId: id,
					before: {
						providerModelId: before.providerModelId,
						connectionId: before.connectionId,
						enabled: before.enabled,
						capabilitiesOverride: before.capabilitiesOverride,
						contextOverride: before.contextOverride,
						status: before.status
					},
					after
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'update failed';
			return fail(409, { error: `Could not update mapping: ${msg}` });
		}
		return { updated: id, message: `Mapping “${providerModelId}” saved.` };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.models');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing mapping id' });
		const [before] = await db
			.select()
			.from(providerModel)
			.where(eq(providerModel.id, id))
			.limit(1);
		if (!before) return fail(404, { error: 'Mapping not found' });
		try {
			await db.transaction(async (tx) => {
				await tx.delete(providerModel).where(eq(providerModel.id, id));
				await writeAudit(tx, {
					actorUserId: locals.user?.id ?? null,
					action: 'provider_model.delete',
					resource: 'provider_model',
					resourceId: id,
					before: {
						modelId: before.modelId,
						providerId: before.providerId,
						providerModelId: before.providerModelId,
						status: before.status
					}
				});
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'delete failed';
			return fail(409, { error: `Could not delete mapping: ${msg}` });
		}
		return { deleted: id, message: `Mapping “${before.providerModelId}” deleted.` };
	}
};
