import { fail, error, redirect } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { user, workspaceMember, workspaceRole } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';
import {
	deleteInvite,
	deletePendingInvites,
	findPendingInvite,
	insertInvite,
	listAssignableRoles,
	type InvitePayload
} from '../invites';
// Team members (PRD §45, §12): the workspace's seats — who holds which role —
// plus the invite/change-role/remove surface. Every mutation is audited in the
// same transaction as the write.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) return { members: [], roles: [], ownerUserId: null };
	const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.read');
	const members = await db
		.select({
			id: workspaceMember.id,
			userId: workspaceMember.userId,
			name: user.name,
			email: user.email,
			roleId: workspaceMember.roleId,
			roleName: workspaceRole.name,
			status: workspaceMember.status,
			createdAt: workspaceMember.createdAt
		})
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(eq(workspaceMember.workspaceId, ws.id))
		.orderBy(asc(workspaceMember.createdAt));
	const roles = await listAssignableRoles(db, ws.id);
	return { members, roles, ownerUserId: ws.ownerUserId };
};
export const actions: Actions = {
	invite: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.invite');
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim().toLowerCase();
		const roleId = String(form.get('roleId') ?? '').trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return fail(400, { error: 'Enter a valid email address' });
		}
		const roles = await listAssignableRoles(db, ws.id);
		const role = roles.find((r) => r.id === roleId);
		if (!role) return fail(400, { error: 'Pick a role for the new member' });
		const [existingUser] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email))
			.limit(1);
		if (existingUser) {
			const [already] = await db
				.select({ id: workspaceMember.id })
				.from(workspaceMember)
				.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.userId, existingUser.id)))
				.limit(1);
			if (already) return fail(400, { error: 'That person is already a member' });
		} else if (await findPendingInvite(db, email, ws.id)) {
			return fail(400, { error: 'An invitation for that email is already pending — resend it instead' });
		}
		const payload: InvitePayload = {
			email,
			workspaceId: ws.id,
			roleId,
			invitedBy: locals.user!.id,
			name: email.split('@')[0]
		};
		const token = await db.transaction(async (tx) => {
			// One live invite per (email, workspace): clear any stale token before
			// minting — a signup between invite and re-invite would otherwise leave
			// the first link alive as a forgotten credential.
			await deletePendingInvites(tx, email, ws.id);
			const invite = await insertInvite(tx, payload);
			// An existing account needs no token dance: the member row is created
			// (or reactivated) right away and the invite row is dropped, so there
			// is never a dead link in an admin's inbox.
			if (existingUser) {
				const [prior] = await tx
					.select({ id: workspaceMember.id })
					.from(workspaceMember)
					.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.userId, existingUser.id)))
					.limit(1);
				if (prior) {
					await tx
						.update(workspaceMember)
						.set({ roleId, status: 'active', updatedAt: new Date() })
						.where(eq(workspaceMember.id, prior.id));
				} else {
					await tx.insert(workspaceMember).values({
						id: newId(ID_PREFIXES.workspaceMember),
						workspaceId: ws.id,
						userId: existingUser.id,
						roleId,
						status: 'active',
						invitedBy: locals.user!.id
					});
				}
				await deleteInvite(tx, invite.id);
			}
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.invite',
				resource: 'workspace_member',
				workspaceId: ws.id,
				metadata: { email, roleId }
			});
			return existingUser ? null : invite.token;
		});
		// The plaintext token exists exactly once, here. No mail is sent: the
		// admin copies this acceptance URL out of the page.
		return { invited: email, ...(token ? { invitedLink: `/invite/${token}` } : {}) };
	},
	changeRole: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		const form = await request.formData();
		const memberId = String(form.get('memberId') ?? '').trim();
		const roleId = String(form.get('roleId') ?? '').trim();
		const [member] = await db
			.select()
			.from(workspaceMember)
			.where(and(eq(workspaceMember.id, memberId), eq(workspaceMember.workspaceId, ws.id)))
			.limit(1);
		if (!member) return error(404, 'Member not found');
		// The workspace owner is the one seat whose role cannot be edited away —
		// ownership is transferred through workspace settings, not through here.
		if (member.userId === ws.ownerUserId) {
			return fail(403, { error: "The workspace owner's role cannot be changed" });
		}
		const roles = await listAssignableRoles(db, ws.id);
		const role = roles.find((r) => r.id === roleId);
		if (!role) return fail(400, { error: 'Unknown role' });
		await db.transaction(async (tx) => {
			await tx
				.update(workspaceMember)
				.set({ roleId, updatedAt: new Date() })
				.where(eq(workspaceMember.id, member.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.change_role',
				resource: 'workspace_member',
				resourceId: member.id,
				workspaceId: ws.id,
				before: { roleId: member.roleId },
				after: { roleId }
			});
		});
		return { changed: member.id };
	},
	remove: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.remove');
		const form = await request.formData();
		const memberId = String(form.get('memberId') ?? '').trim();
		const [member] = await db
			.select({
				id: workspaceMember.id,
				userId: workspaceMember.userId,
				roleId: workspaceMember.roleId,
				status: workspaceMember.status,
				name: user.name
			})
			.from(workspaceMember)
			.innerJoin(user, eq(user.id, workspaceMember.userId))
			.where(and(eq(workspaceMember.id, memberId), eq(workspaceMember.workspaceId, ws.id)))
			.limit(1);
		if (!member) return error(404, 'Member not found');
		if (member.userId === ws.ownerUserId) {
			return fail(403, { error: 'The workspace owner cannot be removed — transfer ownership first' });
		}
		// Typed confirmation: removal deletes the seat and its access, so the
		// member's name must be typed, exactly (contract: destructive ops).
		const confirm = String(form.get('confirm') ?? '').trim();
		if (confirm !== member.name) {
			return fail(400, { error: `Type the member's name “${member.name}” exactly to confirm removal` });
		}
		await db.transaction(async (tx) => {
			await tx.delete(workspaceMember).where(eq(workspaceMember.id, member.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.remove',
				resource: 'workspace_member',
				resourceId: member.id,
				workspaceId: ws.id,
				before: { userId: member.userId, roleId: member.roleId, status: member.status }
			});
		});
		return { removed: member.id };
	},
	resend: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.invite');
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim().toLowerCase();
		if (!email) return fail(400, { error: 'Missing invitation email' });
		const prior = await findPendingInvite(db, email, ws.id);
		if (!prior) return fail(400, { error: 'No pending invitation for that email' });
		// Resend = invalidate the old link and mint a fresh one; the payload
		// (email, role, inviter) carries over unchanged.
		const result = await db.transaction(async (tx) => {
			await deleteInvite(tx, prior.id);
			const fresh = await insertInvite(tx, prior.payload);
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'member.invite_resend',
				resource: 'workspace_member',
				workspaceId: ws.id,
				metadata: { email, roleId: prior.payload.roleId }
			});
			return fresh;
		});
		return { resent: email, invitedLink: `/invite/${result.token}` };
	}
};
