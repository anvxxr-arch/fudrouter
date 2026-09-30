import { fail, redirect, error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { workspace, workspaceMember, workspaceRole } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { deleteInvite, findInviteByToken } from '../../dashboard/team/invites';
// Invitation acceptance (PRD §12, §45). The token IS the credential: this page
// resolves by the stored hash alone and never requires a workspace permission —
// the invitee is by definition not a member yet. `requireCap` is still the
// contract's first statement; `requireMemberPermission` is deliberately absent.
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'member');
	const invite = await findInviteByToken(db, params.token);
	if (!invite) error(404, 'This invitation is invalid or has expired');
	const [context] = await db
		.select({ workspaceName: workspace.name, roleName: workspaceRole.name })
		.from(workspace)
		.innerJoin(workspaceRole, eq(workspaceRole.id, invite.payload.roleId))
		.where(eq(workspace.id, invite.payload.workspaceId))
		.limit(1);
	if (!context) error(404, 'This invitation is invalid or has expired');
	return {
		invite: { email: invite.payload.email, name: invite.payload.name },
		workspaceName: context.workspaceName,
		roleName: context.roleName,
		expiresAt: invite.expiresAt
	};
};
export const actions: Actions = {
	accept: async ({ locals, params, cookies }) => {
		requireCap(locals, 'member');
		if (!locals.user) redirect(303, '/login');
		const invite = await findInviteByToken(db, params.token);
		if (!invite) error(404, 'This invitation is invalid or has expired');
		if (invite.payload.email !== locals.user.email) {
			return fail(403, { error: 'This invitation was sent to a different email address' });
		}
		await db.transaction(async (tx) => {
			// Upsert on (workspaceId, userId): a re-invite or a previously
			// suspended seat becomes active with the invited role.
			const [prior] = await tx
				.select({ id: workspaceMember.id })
				.from(workspaceMember)
				.where(
					and(
						eq(workspaceMember.workspaceId, invite.payload.workspaceId),
						eq(workspaceMember.userId, locals.user!.id)
					)
				)
				.limit(1);
			if (prior) {
				await tx
					.update(workspaceMember)
					.set({ roleId: invite.payload.roleId, status: 'active', updatedAt: new Date() })
					.where(eq(workspaceMember.id, prior.id));
			} else {
				await tx.insert(workspaceMember).values({
					id: newId(ID_PREFIXES.workspaceMember),
					workspaceId: invite.payload.workspaceId,
					userId: locals.user!.id,
					roleId: invite.payload.roleId,
					status: 'active',
					invitedBy: invite.payload.invitedBy
				});
			}
			await deleteInvite(tx, invite.id);
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.accept',
				resource: 'workspace_member',
				workspaceId: invite.payload.workspaceId,
				metadata: { email: invite.payload.email, roleId: invite.payload.roleId }
			});
		});
		// The shell points at the workspace just joined (cookie rules: path '/',
		// 1 year, lax).
		cookies.set('fwid', invite.payload.workspaceId, {
			path: '/',
			maxAge: 31536000,
			sameSite: 'lax'
		});
		redirect(303, '/dashboard');
	},
	decline: async ({ locals, params }) => {
		requireCap(locals, 'member');
		const invite = await findInviteByToken(db, params.token);
		if (!invite) error(404, 'This invitation is invalid or has expired');
		await db.transaction(async (tx) => {
			await deleteInvite(tx, invite.id);
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.decline',
				resource: 'workspace_member',
				workspaceId: invite.payload.workspaceId,
				metadata: { email: invite.payload.email, roleId: invite.payload.roleId }
			});
		});
		redirect(303, '/dashboard');
	}
};
