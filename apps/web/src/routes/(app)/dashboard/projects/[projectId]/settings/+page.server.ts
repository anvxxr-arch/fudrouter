import { fail, redirect, error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { apiKey, project } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { slugify } from '$lib/server/provision';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
const PROJECT_STATUSES = ['active', 'archived', 'suspended'] as const;
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
			createdAt: project.createdAt,
			updatedAt: project.updatedAt
		})
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	return { project: proj, statuses: PROJECT_STATUSES };
};
export const actions: Actions = {
	update: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
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
		const name = String(form.get('name') ?? '').trim();
		const slugInput = String(form.get('slug') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const status = String(form.get('status') ?? '').trim();
		if (!name) return fail(400, { error: 'Project name is required' });
		if (!(PROJECT_STATUSES as readonly string[]).includes(status)) {
			return fail(400, { error: 'Invalid project status' });
		}
		const slug = slugInput || slugify(name);
		if (slug !== proj.slug) {
			const [taken] = await db
				.select({ id: project.id })
				.from(project)
				.where(and(eq(project.workspaceId, workspaceId), eq(project.slug, slug)))
				.limit(1);
			if (taken) return fail(400, { error: `Slug “${slug}” is already used by another project` });
		}
		const after = { name, slug, description: description || null, status };
		await db.transaction(async (tx) => {
			await tx
				.update(project)
				.set({ name, slug, description: description || null, status, updatedAt: new Date() })
				.where(eq(project.id, proj.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'project.update',
				resource: 'project',
				resourceId: proj.id,
				workspaceId,
				before: {
					name: proj.name,
					slug: proj.slug,
					description: proj.description,
					status: proj.status
				},
				after
			});
		});
		return { saved: true };
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
