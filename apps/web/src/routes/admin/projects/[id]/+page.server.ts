import { error, fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import {
	apiKey,
	environment,
	project,
	requestLog,
	workspace
} from '$lib/server/db/schema';
const PROJECT_STATUSES = ['active', 'archived', 'suspended'] as const;
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.users');
	const [proj] = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			description: project.description,
			status: project.status,
			createdAt: project.createdAt,
			updatedAt: project.updatedAt,
			workspaceId: workspace.id,
			workspaceName: workspace.name
		})
		.from(project)
		.innerJoin(workspace, eq(workspace.id, project.workspaceId))
		.where(eq(project.id, params.id))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	const id = proj.id;
	const environments = await db
		.select({
			id: environment.id,
			name: environment.name,
			slug: environment.slug,
			type: environment.type,
			status: environment.status,
			routingPolicyId: environment.routingPolicyId
		})
		.from(environment)
		.where(eq(environment.projectId, id))
		.orderBy(environment.name);
	// API key METADATA only: never `key_hash`, never a secret.
	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			status: apiKey.status,
			environmentId: apiKey.environmentId,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt
		})
		.from(apiKey)
		.where(eq(apiKey.projectId, id))
		.orderBy(apiKey.createdAt);
	const [usage] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.projectId, id));
	return {
		project: proj,
		environments,
		keys,
		usage: usage ?? { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' },
		statuses: PROJECT_STATUSES
	};
};
export const actions: Actions = {
	setStatus: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const status = String(form.get('status') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing project id' });
		if (!(PROJECT_STATUSES as readonly string[]).includes(status)) {
			return fail(400, { error: 'Invalid status' });
		}
		const [target] = await db
			.select({ status: project.status, workspaceId: project.workspaceId })
			.from(project)
			.where(eq(project.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'Project not found' });
		await db.transaction(async (tx) => {
			await tx.update(project).set({ status }).where(eq(project.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'project.status_set',
				resource: 'project',
				resourceId: id,
				workspaceId: target.workspaceId,
				before: { status: target.status },
				after: { status }
			});
		});
		return { statusSet: id };
	}
};
