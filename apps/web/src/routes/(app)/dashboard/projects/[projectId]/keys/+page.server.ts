import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, environment } from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { writeAudit } from '$lib/server/audit';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { requireCap } from '$lib/server/roles';
import { policyFromForm, scopedProject } from './common';

// Project API keys (PRD §25): list, create, enable/disable. The secret exists
// only in the create response — every column selection here is explicit and
// `keyHash` is never among them. Playground-minted keys are excluded from the
// list (they are short-lived probes, linked from request rows only).
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'key.read');
	const proj = await scopedProject(params.projectId, workspaceId);
	const environments = await db
		.select({ id: environment.id, name: environment.name, status: environment.status })
		.from(environment)
		.where(eq(environment.projectId, proj.id))
		.orderBy(desc(environment.createdAt));
	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			status: apiKey.status,
			environmentId: apiKey.environmentId,
			createdAt: apiKey.createdAt,
			lastUsedAt: apiKey.lastUsedAt,
			expiresAt: apiKey.expiresAt
		})
		.from(apiKey)
		.where(
			and(
				eq(apiKey.projectId, proj.id),
				eq(apiKey.workspaceId, workspaceId),
				sql`coalesce(${apiKey.policy}->>'playground', '') <> 'true'`
			)
		)
		.orderBy(desc(apiKey.createdAt));
	return {
		projectId: proj.id,
		projectName: proj.name,
		environments,
		keys: keys.map((k) => ({
			...k,
			environmentName: environments.find((e) => e.id === k.environmentId)?.name ?? null
		}))
	};
};

export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.create');
		const proj = await scopedProject(params.projectId, workspaceId);
		const form = await request.formData();

		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Key name is required' });

		const environmentId = String(form.get('environmentId') ?? '').trim();
		const [env] = await db
			.select({ id: environment.id })
			.from(environment)
			.where(and(eq(environment.id, environmentId), eq(environment.projectId, proj.id)))
			.limit(1);
		if (!env) return fail(400, { error: 'Pick an environment of this project' });

		// Optional expiry: a bare date input. Empty = no expiry (column NULL).
		const expiresRaw = String(form.get('expiresAt') ?? '').trim();
		let expiresAt: Date | null = null;
		if (expiresRaw) {
			expiresAt = new Date(`${expiresRaw}T00:00:00.000Z`);
			if (Number.isNaN(expiresAt.getTime())) return fail(400, { error: 'Expiration is not a date' });
		}

		const parsed = policyFromForm(form);
		if (!parsed.ok) return fail(400, { error: parsed.error });

		const { key, prefix, keyHash } = generateApiKey();
		const id = newId(ID_PREFIXES.apiKey);
		await db.transaction(async (tx) => {
			await tx.insert(apiKey).values({
				id,
				workspaceId,
				projectId: proj.id,
				environmentId: env.id,
				userId: locals.user!.id,
				name,
				prefix,
				keyHash,
				policy: parsed.policy,
				expiresAt,
				status: 'active'
			});
			// The plaintext key never touches the audit trail — not in metadata,
			// not anywhere. Only what identifies the row does.
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.create',
				resource: 'api_key',
				resourceId: id,
				workspaceId,
				metadata: { name, prefix, environmentId: env.id }
			});
		});
		// The plaintext key exists only in this response. Only sha256(secret) is
		// stored, so a lost key can be revoked and reissued but never recovered.
		return { created: key, name };
	},
	enable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		const [row] = await db
			.select({ id: apiKey.id, name: apiKey.name, status: apiKey.status })
			.from(apiKey)
			.where(and(eq(apiKey.id, id), eq(apiKey.projectId, proj.id), eq(apiKey.workspaceId, workspaceId)))
			.limit(1);
		if (!row) return fail(404, { error: 'Key not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ status: 'active', updatedAt: new Date() })
				.where(eq(apiKey.id, row.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.enable',
				resource: 'api_key',
				resourceId: row.id,
				workspaceId,
				before: { status: row.status },
				after: { status: 'active' }
			});
		});
		return { enabled: row.name };
	},
	disable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing key id' });
		const [row] = await db
			.select({ id: apiKey.id, name: apiKey.name, status: apiKey.status })
			.from(apiKey)
			.where(and(eq(apiKey.id, id), eq(apiKey.projectId, proj.id), eq(apiKey.workspaceId, workspaceId)))
			.limit(1);
		if (!row) return fail(404, { error: 'Key not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ status: 'disabled', updatedAt: new Date() })
				.where(eq(apiKey.id, row.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.disable',
				resource: 'api_key',
				resourceId: row.id,
				workspaceId,
				before: { status: row.status },
				after: { status: 'disabled' }
			});
		});
		return { disabled: row.name };
	}
};
