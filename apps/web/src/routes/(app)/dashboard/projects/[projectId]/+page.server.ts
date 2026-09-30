import { fail, redirect, error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, environment, project } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
// Playground-minted keys are short-lived test credentials (policy.playground),
// not project infrastructure: they must not inflate the per-environment key
// summary on this page.
const NOT_PLAYGROUND = sql`coalesce(${apiKey.policy}->>'playground', '') <> 'true'`;
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'project.read');
	const [proj] = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			description: project.description,
			status: project.status,
			createdAt: project.createdAt
		})
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	const envs = await db
		.select({
			id: environment.id,
			name: environment.name,
			slug: environment.slug,
			type: environment.type,
			status: environment.status
		})
		.from(environment)
		.where(eq(environment.projectId, proj.id))
		.orderBy(environment.createdAt);
	const counts = await db
		.select({ environmentId: apiKey.environmentId, count: sql<number>`count(*)::int` })
		.from(apiKey)
		.where(and(eq(apiKey.projectId, proj.id), NOT_PLAYGROUND))
		.groupBy(apiKey.environmentId);
	const keyCountByEnv = new Map(counts.map((c) => [c.environmentId, c.count]));
	const environments = envs.map((e) => ({ ...e, keyCount: keyCountByEnv.get(e.id) ?? 0 }));
	return { project: proj, environments };
};
export const actions: Actions = {
	rename: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const [proj] = await db
			.select({ id: project.id, name: project.name })
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Project name is required' });
		await db.transaction(async (tx) => {
			await tx.update(project).set({ name, updatedAt: new Date() }).where(eq(project.id, proj.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.update',
				resource: 'project',
				resourceId: proj.id,
				workspaceId,
				before: { name: proj.name },
				after: { name }
			});
		});
		return { renamed: name };
	},
	archive: async ({ locals, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const [proj] = await db
			.select({ id: project.id, name: project.name, status: project.status })
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		await db.transaction(async (tx) => {
			await tx
				.update(project)
				.set({ status: 'archived', updatedAt: new Date() })
				.where(eq(project.id, proj.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.archive',
				resource: 'project',
				resourceId: proj.id,
				workspaceId,
				before: { status: proj.status },
				after: { status: 'archived' }
			});
		});
		return { archived: proj.name };
	},
	restore: async ({ locals, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const [proj] = await db
			.select({ id: project.id, name: project.name, status: project.status })
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		await db.transaction(async (tx) => {
			await tx
				.update(project)
				.set({ status: 'active', updatedAt: new Date() })
				.where(eq(project.id, proj.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.restore',
				resource: 'project',
				resourceId: proj.id,
				workspaceId,
				before: { status: proj.status },
				after: { status: 'active' }
			});
		});
		return { restored: proj.name };
	},
	switch: async ({ locals, params, cookies }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const [proj] = await db
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		const [env] = await db
			.select({ id: environment.id })
			.from(environment)
			.where(eq(environment.projectId, proj.id))
			.orderBy(environment.createdAt)
			.limit(1);
		cookies.set('fpid', proj.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		if (env) cookies.set('feid', env.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		else cookies.delete('feid', { path: '/' });
		redirect(303, `/dashboard/projects/${proj.id}`);
	},
	delete: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.delete');
		const [proj] = await db
			.select({
				id: project.id,
				name: project.name,
				slug: project.slug,
				description: project.description,
				status: project.status
			})
			.from(project)
			.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) error(404, 'Project not found');
		const form = await request.formData();
		const confirm = String(form.get('confirm') ?? '').trim();
		if (confirm !== proj.name) {
			return fail(400, { error: `Type the project name “${proj.name}” exactly to confirm deletion` });
		}
		// PRD §109: keys are the project's live credentials — deleting out from
		// under them needs the explicit force opt-in, never the default.
		const keyCount = await db.$count(apiKey, eq(apiKey.projectId, proj.id));
		if (keyCount > 0 && !form.get('force')) {
			return fail(400, {
				error: `Project still has API keys — ${keyCount} key(s) would be deleted with it. Remove them first, or tick “force” to delete them too.`
			});
		}
		await db.transaction(async (tx) => {
			// audit_log has no FK on the project: the record of the deletion
			// survives the deletion itself.
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.delete',
				resource: 'project',
				resourceId: proj.id,
				workspaceId,
				before: { name: proj.name, slug: proj.slug, description: proj.description, status: proj.status },
				metadata: { forced: Boolean(form.get('force')), keyCount }
			});
			// Environments and API keys cascade with the project
			// (request_log rows survive, project_id set NULL).
			await tx.delete(project).where(eq(project.id, proj.id));
		});
		redirect(303, '/dashboard/projects');
	}
};
