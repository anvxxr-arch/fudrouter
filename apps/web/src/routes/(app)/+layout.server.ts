import { redirect } from '@sveltejs/kit';
import { and, eq, asc, isNotNull } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId } from '$lib/server/rbac';
import { ensureUserWorkspace } from '$lib/server/provision';
import { db } from '$lib/server/db';
import { environment, project, workspace, workspaceMember } from '$lib/server/db/schema';

// The member surface needs a session, then the capability. The hook is the first
// gate; this is the second, so a change to the route table alone can never open
// this area to a signed-in user who lacks `member`.
//
// It also carries the shell switchers' data (PRD §141): the workspaces/projects/
// environments the header pickers list, and the `fwid`/`fpid`/`feid` selection.
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) redirect(303, '/login');
	requireCap(locals, 'member');
	const userId = locals.user.id;
	// Backstop provisioning (PRD §44): the signup hook builds the default tree,
	// this guarantees it for users created any other way.
	await ensureUserWorkspace(db, { userId, name: locals.user.name });
	const workspaces = await db
		.select({ id: workspace.id, name: workspace.name })
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.status, 'active')));
	const workspaceId = await currentWorkspaceId(locals);
	if (workspaceId && workspaceId !== cookies.get('fwid')) {
		cookies.set('fwid', workspaceId, { path: '/', maxAge: 31536000, sameSite: 'lax' });
	}
	const projects = workspaceId
		? await db
				.select({ id: project.id, name: project.name })
				.from(project)
				.where(and(eq(project.workspaceId, workspaceId), eq(project.status, 'active')))
				.orderBy(asc(project.createdAt))
		: [];
	const projectId = projects.some((p) => p.id === cookies.get('fpid'))
		? cookies.get('fpid')!
		: (projects[0]?.id ?? null);
	const environments = projectId
		? await db
				.select({ id: environment.id, name: environment.name, slug: environment.slug })
				.from(environment)
				.where(and(eq(environment.projectId, projectId), eq(environment.status, 'active')))
				.orderBy(asc(environment.createdAt))
		: [];
	const environmentId = environments.some((e) => e.id === cookies.get('feid'))
		? cookies.get('feid')!
		: (environments[0]?.id ?? null);
	return {
		shell: {
			workspaces,
			workspaceId,
			projects,
			projectId,
			environments,
			environmentId
		}
	};
};
