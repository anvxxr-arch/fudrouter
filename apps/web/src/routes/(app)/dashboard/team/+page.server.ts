import { desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { workspaceMember, workspaceRole } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { listWorkspaceInvites } from './invites';
// Team overview (PRD §45): how the workspace's seats are used — member count,
// pending invitations, and the role → member-count rollup — with links into the
// three management pages. Read-only: every mutation lives on a sub-page.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) return { memberCount: 0, pendingCount: 0, roles: [] };
	const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.read');
	const memberCount = await db.$count(workspaceMember, eq(workspaceMember.workspaceId, ws.id));
	const pendingCount = (await listWorkspaceInvites(db, ws.id)).length;
	const rows = await db
		.select({ name: workspaceRole.name, count: sql<number>`count(*)::int` })
		.from(workspaceMember)
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(eq(workspaceMember.workspaceId, ws.id))
		.groupBy(workspaceRole.name)
		.orderBy(desc(sql`count(*)`), workspaceRole.name);
	return { memberCount, pendingCount, roles: rows };
};
