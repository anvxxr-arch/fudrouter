import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { environment, project } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { createProject } from '$lib/server/provision';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
// The project list (PRD §22): every project in the workspace the shell is
// pointed at, with create/switch/archive/restore. Rows are scoped by
// workspaceId alone — an id from another workspace can never be shown or
// switched to.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'project.read');
	const projects = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			description: project.description,
			status: project.status,
			createdAt: project.createdAt
		})
		.from(project)
		.where(eq(project.workspaceId, workspaceId))
		.orderBy(desc(project.createdAt));
	return { projects };
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		if (!name) return fail(400, { error: 'Project name is required' });
		const createdId = await db.transaction(async (tx) => {
			const created = await createProject(tx, {
				workspaceId,
				name,
				description: description || null
			});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.create',
				resource: 'project',
				resourceId: created.id,
				workspaceId,
				after: { name, slug: created.slug, description: description || null }
			});
			return created.id;
		});
		redirect(303, `/dashboard/projects/${createdId}`);
	},
	switch: async ({ locals, request, cookies }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const projectId = String(form.get('projectId') ?? '').trim();
		const [target] = await db
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!target) return fail(404, { error: 'Project not found' });
		// A stale environment id from the previous project would leak its context
		// into the new one — repoint `feid` at this project's first environment.
		const [env] = await db
			.select({ id: environment.id })
			.from(environment)
			.where(eq(environment.projectId, target.id))
			.orderBy(environment.createdAt)
			.limit(1);
		cookies.set('fpid', target.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		if (env) cookies.set('feid', env.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		else cookies.delete('feid', { path: '/' });
		redirect(303, '/dashboard/projects');
	},
	archive: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const projectId = String(form.get('projectId') ?? '').trim();
		const [target] = await db
			.select({ id: project.id, name: project.name, status: project.status })
			.from(project)
			.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!target) return fail(404, { error: 'Project not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(project)
				.set({ status: 'archived', updatedAt: new Date() })
				.where(eq(project.id, target.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.archive',
				resource: 'project',
				resourceId: target.id,
				workspaceId,
				before: { status: target.status },
				after: { status: 'archived' }
			});
		});
		return { archived: target.name };
	},
	restore: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const projectId = String(form.get('projectId') ?? '').trim();
		const [target] = await db
			.select({ id: project.id, name: project.name, status: project.status })
			.from(project)
			.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!target) return fail(404, { error: 'Project not found' });
		await db.transaction(async (tx) => {
			await tx
				.update(project)
				.set({ status: 'active', updatedAt: new Date() })
				.where(eq(project.id, target.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.restore',
				resource: 'project',
				resourceId: target.id,
				workspaceId,
				before: { status: target.status },
				after: { status: 'active' }
			});
		});
		return { restored: target.name };
	}
};
