/**
 * The shared gate for every OBSERVE/CONTROL page loader and action.
 *
 * Three checks, in the repo's order (see the keys pages): platform capability
 * `requireCap` stays a literal call in each handler (route-gates.test.ts counts
 * it per file), then workspace RBAC, then the project scoped by workspace.
 *
 * PRD §108 wants an in-page "permission denied" state, so a 403 from RBAC is
 * RETURNED as `{ denied: true }` (the page renders `<UxState state="denied">`)
 * rather than thrown at the error page. A project that does not resolve inside
 * the caller's workspace stays a thrown 404 — an id must not reveal whether it
 * exists in another tenant (same contract as keys/common.ts scopedProject).
 */
import { error, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { project } from '$lib/server/db/schema';
import {
	currentWorkspaceId,
	requireMemberPermission,
	type WorkspacePermission
} from '$lib/server/rbac';

export type ObserveGate =
	| { denied: true }
	| { denied: false; workspaceId: string; project: { id: string; name: string } };

/**
 * Resolve the workspace + project a page works on, or report that the caller
 * may not. `perm` is the spec §2 permission code the page needs.
 */
export async function observeGate(
	locals: App.Locals,
	projectId: string,
	perm: WorkspacePermission
): Promise<ObserveGate> {
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	try {
		await requireMemberPermission(locals, workspaceId, perm);
	} catch {
		return { denied: true };
	}
	const [proj] = await db
		.select({ id: project.id, name: project.name })
		.from(project)
		.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	return { denied: false, workspaceId, project: proj };
}

/**
 * Same three checks for workspace-scoped pages (no project param), e.g.
 * /dashboard/usage. A caller with no workspace has nothing to show.
 */
export async function observeWorkspaceGate(
	locals: App.Locals,
	perm: WorkspacePermission
): Promise<{ denied: true } | { denied: false; workspaceId: string }> {
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	try {
		await requireMemberPermission(locals, workspaceId, perm);
	} catch {
		return { denied: true };
	}
	return { denied: false, workspaceId };
}
