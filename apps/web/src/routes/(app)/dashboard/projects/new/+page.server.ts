import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { createProject } from '$lib/server/provision';
import { writeAudit } from '$lib/server/audit';
import { requireCap } from '$lib/server/roles';
// New-project form (PRD §22): name + optional description, slug derived by
// `createProject` unless given. Lands on the project overview afterwards.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	await requireMemberPermission(locals, workspaceId, 'project.read');
	return {};
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		await requireMemberPermission(locals, workspaceId, 'project.write');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const slug = String(form.get('slug') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		if (!name) return fail(400, { error: 'Project name is required' });
		const createdId = await db.transaction(async (tx) => {
			const created = await createProject(tx, {
				workspaceId,
				name,
				slug: slug || undefined,
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
	}
};
