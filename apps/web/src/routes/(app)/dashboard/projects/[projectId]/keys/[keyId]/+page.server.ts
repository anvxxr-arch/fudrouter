import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, environment, requestLog } from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';
import { writeAudit } from '$lib/server/audit';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { requireCap } from '$lib/server/roles';
import { confirmError, scopedKey, scopedProject } from '../common';

// Key detail (PRD §26): identity + policy + usage aggregates and the last 10
// request rows. `keyHash` is never selected here — a page refresh re-fetches
// this payload and it must carry zero secret material. The plaintext key
// exists only in the create/rotate ACTION response.
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'key.read');
	const proj = await scopedProject(params.projectId, workspaceId);
	const key = await scopedKey(params.keyId, proj.id, workspaceId);

	const [env] = key.environmentId
		? await db
				.select({ id: environment.id, name: environment.name })
				.from(environment)
				.where(eq(environment.id, key.environmentId))
				.limit(1)
		: [];

	const [totals] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			successes: sql<number>`count(*) filter (where ${requestLog.status} = 'success')::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.apiKeyId, key.id));

	const recent = await db
		.select({
			id: requestLog.id,
			createdAt: requestLog.createdAt,
			requestedModel: requestLog.requestedModel,
			status: requestLog.status,
			cost: requestLog.cost
		})
		.from(requestLog)
		.where(eq(requestLog.apiKeyId, key.id))
		.orderBy(desc(requestLog.createdAt))
		.limit(10);

	return {
		projectId: proj.id,
		projectName: proj.name,
		key,
		environmentName: env?.name ?? null,
		totals,
		recent
	};
};

export const actions: Actions = {
	rotate: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.rotate');
		const proj = await scopedProject(params.projectId, workspaceId);
		const key = await scopedKey(params.keyId, proj.id, workspaceId);
		const form = await request.formData();
		const confirmProblem = confirmError(form, key.name);
		if (confirmProblem) return fail(400, { error: confirmProblem });

		// Rotation reissues the secret on the SAME row: prefix + hash are
		// rewritten and the old secret stops authenticating immediately.
		const { key: plaintext, prefix, keyHash } = generateApiKey();
		const now = new Date();
		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ prefix, keyHash, updatedAt: now })
				.where(eq(apiKey.id, key.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.rotate',
				resource: 'api_key',
				resourceId: key.id,
				workspaceId,
				before: { prefix: key.prefix },
				after: { prefix }
			});
		});
		// The new plaintext exists only in this response; nothing stores it.
		return { created: plaintext, name: key.name };
	},
	revoke: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const key = await scopedKey(params.keyId, proj.id, workspaceId);
		const form = await request.formData();
		const confirmProblem = confirmError(form, key.name);
		if (confirmProblem) return fail(400, { error: confirmProblem });

		const now = new Date();
		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ status: 'revoked', revokedAt: now, updatedAt: now })
				.where(eq(apiKey.id, key.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.revoke',
				resource: 'api_key',
				resourceId: key.id,
				workspaceId,
				before: { status: key.status },
				after: { status: 'revoked' }
			});
		});
		return { revoked: key.name };
	},
	enable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const key = await scopedKey(params.keyId, proj.id, workspaceId);
		const form = await request.formData();
		const confirmProblem = confirmError(form, key.name);
		if (confirmProblem) return fail(400, { error: confirmProblem });

		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ status: 'active', updatedAt: new Date() })
				.where(eq(apiKey.id, key.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.enable',
				resource: 'api_key',
				resourceId: key.id,
				workspaceId,
				before: { status: key.status },
				after: { status: 'active' }
			});
		});
		return { enabled: key.name };
	},
	disable: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const key = await scopedKey(params.keyId, proj.id, workspaceId);
		const form = await request.formData();
		const confirmProblem = confirmError(form, key.name);
		if (confirmProblem) return fail(400, { error: confirmProblem });

		await db.transaction(async (tx) => {
			await tx
				.update(apiKey)
				.set({ status: 'disabled', updatedAt: new Date() })
				.where(eq(apiKey.id, key.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.disable',
				resource: 'api_key',
				resourceId: key.id,
				workspaceId,
				before: { status: key.status },
				after: { status: 'disabled' }
			});
		});
		return { disabled: key.name };
	},
	delete: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'key.revoke');
		const proj = await scopedProject(params.projectId, workspaceId);
		const key = await scopedKey(params.keyId, proj.id, workspaceId);
		const form = await request.formData();
		const confirmProblem = confirmError(form, key.name);
		if (confirmProblem) return fail(400, { error: confirmProblem });

		// PRD §109 style stopper: an active key is removed from the world by
		// revoking it first; deleting while live needs the explicit force tick.
		if (key.status === 'active' && !form.get('force')) {
			return fail(400, {
				error: `“${key.name}” is still active. Revoke or disable it first, or tick “force”.`
			});
		}

		await db.transaction(async (tx) => {
			// audit_log has no FK on the key: the record of the deletion survives
			// the deletion itself. `before` holds the row-ish dict; keyHash is
			// never selected into it (secret material stays out of the trail).
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'key.delete',
				resource: 'api_key',
				resourceId: key.id,
				workspaceId,
				before: {
					name: key.name,
					prefix: key.prefix,
					status: key.status,
					environmentId: key.environmentId,
					createdAt: key.createdAt,
					expiresAt: key.expiresAt
				},
				metadata: { forced: Boolean(form.get('force')) }
			});
			await tx.delete(apiKey).where(eq(apiKey.id, key.id));
		});
		redirect(303, `/dashboard/projects/${proj.id}/keys`);
	}
};
