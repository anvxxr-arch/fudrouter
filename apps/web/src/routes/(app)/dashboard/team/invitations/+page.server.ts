import { fail, error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';
import {
	deleteInvite,
	findInviteByIdentifier,
	listAssignableRoles,
	listWorkspaceInvites
} from '../invites';
// Pending invitations (PRD §45, §12): the outbox of one-time acceptance links.
// Only the token HASH is stored, so a row here can be revoked — never read back.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) return { invitations: [], roles: [] };
	const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.read');
	// The assignable role rows (builtin templates + this workspace's customs)
	// let the table name the role each pending link carries.
	const roles = await listAssignableRoles(db, ws.id);
	const invitations = await listWorkspaceInvites(db, ws.id);
	return { invitations, roles };
};
export const actions: Actions = {
	revoke: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.invite');
		const form = await request.formData();
		const identifier = String(form.get('identifier') ?? '').trim();
		if (!identifier) return fail(400, { error: 'Missing invitation' });
		const invite = await findInviteByIdentifier(db, identifier);
		if (!invite) return error(404, 'Invitation not found');
		if (invite.payload.workspaceId !== ws.id) return error(404, 'Invitation not found');
		await db.transaction(async (tx) => {
			await deleteInvite(tx, invite.id);
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.invite_revoke',
				resource: 'workspace_member',
				workspaceId: ws.id,
				metadata: { email: invite.payload.email, roleId: invite.payload.roleId }
			});
		});
		return { revoked: invite.payload.email };
	}
};
