import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { cleanField, parseBoolField, parseJsonField } from '$lib/server/admin-vocab';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { featureFlag } from '$lib/server/db/schema';
import { newId, ID_PREFIXES } from '$lib/server/id';

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.settings');
	const rows = await db
		.select({
			id: featureFlag.id,
			name: featureFlag.name,
			description: featureFlag.description,
			enabled: featureFlag.enabled,
			rollout: featureFlag.rollout,
			updatedAt: featureFlag.updatedAt
		})
		.from(featureFlag)
		.orderBy(featureFlag.name);
	return { flags: rows };
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const name = cleanField(form.get('name'), 100);
		const description = cleanField(form.get('description'), 500) ?? '';
		const enabled = parseBoolField(form.get('enabled'));
		const rollout = parseJsonField(form.get('rollout'));
		if (!name) return fail(400, { error: 'Name is required (max 100 chars)' });
		if (rollout === null) return fail(400, { error: 'Rollout must be a JSON object' });
		const dupe = await db
			.select({ id: featureFlag.id })
			.from(featureFlag)
			.where(eq(featureFlag.name, name))
			.limit(1);
		if (dupe.length > 0) {
			return fail(400, { error: 'A feature flag with that name already exists' });
		}
		const id = newId(ID_PREFIXES.featureFlag);
		const actor = locals.user?.id ?? null;
		try {
			await db.transaction(async (tx) => {
				await tx.insert(featureFlag).values({
					id,
					name,
					description,
					enabled,
					rollout,
					updatedBy: actor,
					updatedAt: new Date()
				});
				await writeAudit(tx, {
					actorUserId: actor,
					action: 'feature_flag.create',
					resource: 'feature_flag',
					resourceId: id,
					before: null,
					after: { name, description, enabled, rollout }
				});
			});
		} catch {
			return fail(400, { error: 'Could not create feature flag' });
		}
		return { created: name };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = cleanField(form.get('name'), 100);
		const description = cleanField(form.get('description'), 500) ?? '';
		const enabled = parseBoolField(form.get('enabled'));
		const rollout = parseJsonField(form.get('rollout'));
		if (!id) return fail(400, { error: 'Missing feature flag id' });
		if (!name) return fail(400, { error: 'Name is required (max 100 chars)' });
		if (rollout === null) return fail(400, { error: 'Rollout must be a JSON object' });
		const dupe = await db
			.select({ id: featureFlag.id })
			.from(featureFlag)
			.where(eq(featureFlag.name, name))
			.limit(1);
		if (dupe.length > 0 && dupe[0].id !== id) {
			return fail(400, { error: 'A feature flag with that name already exists' });
		}
		const actor = locals.user?.id ?? null;
		try {
			const updated = await db.transaction(async (tx) => {
				const rows = await tx.select().from(featureFlag).where(eq(featureFlag.id, id)).limit(1);
				if (rows.length === 0) return null;
				const before = {
					name: rows[0].name,
					description: rows[0].description,
					enabled: rows[0].enabled,
					rollout: rows[0].rollout
				};
				const after = { name, description, enabled, rollout };
				await tx
					.update(featureFlag)
					.set({ name, description, enabled, rollout, updatedBy: actor, updatedAt: new Date() })
					.where(eq(featureFlag.id, id));
				await writeAudit(tx, {
					actorUserId: actor,
					action: 'feature_flag.update',
					resource: 'feature_flag',
					resourceId: id,
					before,
					after
				});
				return after;
			});
			if (!updated) return fail(404, { error: 'Feature flag not found' });
		} catch {
			return fail(400, { error: 'Could not update feature flag' });
		}
		return { updated: name };
	},
	toggle: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing feature flag id' });
		const actor = locals.user?.id ?? null;
		const toggled = await db.transaction(async (tx) => {
			const rows = await tx
				.select({ enabled: featureFlag.enabled })
				.from(featureFlag)
				.where(eq(featureFlag.id, id))
				.limit(1);
			if (rows.length === 0) return null;
			const before = { enabled: rows[0].enabled };
			const after = { enabled: !rows[0].enabled };
			await tx
				.update(featureFlag)
				.set({ enabled: after.enabled, updatedBy: actor, updatedAt: new Date() })
				.where(eq(featureFlag.id, id));
			await writeAudit(tx, {
				actorUserId: actor,
				action: after.enabled ? 'feature_flag.enable' : 'feature_flag.disable',
				resource: 'feature_flag',
				resourceId: id,
				before,
				after
			});
			return after;
		});
		if (!toggled) return fail(404, { error: 'Feature flag not found' });
		return { toggled: id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.settings');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing feature flag id' });
		const actor = locals.user?.id ?? null;
		const deleted = await db.transaction(async (tx) => {
			const rows = await tx.select().from(featureFlag).where(eq(featureFlag.id, id)).limit(1);
			if (rows.length === 0) return null;
			const before = {
				name: rows[0].name,
				description: rows[0].description,
				enabled: rows[0].enabled,
				rollout: rows[0].rollout
			};
			await tx.delete(featureFlag).where(eq(featureFlag.id, id));
			await writeAudit(tx, {
				actorUserId: actor,
				action: 'feature_flag.delete',
				resource: 'feature_flag',
				resourceId: id,
				before,
				after: null
			});
			return before;
		});
		if (!deleted) return fail(404, { error: 'Feature flag not found' });
		return { deleted: deleted.name };
	}
};
