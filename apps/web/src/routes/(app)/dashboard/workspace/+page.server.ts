import { fail, redirect } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	environment,
	project,
	user,
	workspace,
	workspaceMember,
	workspaceRole
} from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';

// Workspace settings (PRD §22, §44, §109): rename, transfer ownership,
// archive/restore, and delete behind typed confirmation. The delete is the
// only workspace-level destructive action, so `workspace.delete` (owner-only
// per the spec §2 matrix) carries it and the typed name is the second gate.

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) redirect(303, '/dashboard');
	const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.read');
	const [owner] = await db
		.select({ id: user.id, name: user.name, email: user.email })
		.from(user)
		.where(eq(user.id, ws.ownerUserId ?? ''))
		.limit(1);
	const [counts] = await db
		.select({
			projects: sql<number>`count(distinct ${project.id}) filter (where ${project.status} != 'suspended')::int`,
			members: sql<number>`count(distinct ${workspaceMember.id})::int`
		})
		.from(workspaceMember)
		.leftJoin(project, eq(project.workspaceId, ws.id))
		.where(eq(workspaceMember.workspaceId, ws.id));
	const members = await db
		.select({ userId: workspaceMember.userId, name: user.name, email: user.email })
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.status, 'active')));
	return {
		workspace: {
			id: ws.id,
			name: ws.name,
			slug: ws.slug,
			status: ws.status,
			ownerUserId: ws.ownerUserId
		},
		owner: owner ?? null,
		isOwner: locals.user!.id === ws.ownerUserId,
		projectCount: counts?.projects ?? 0,
		memberCount: counts?.members ?? 0,
		members: members.filter((m) => m.userId !== ws.ownerUserId)
	};
};

export const actions: Actions = {
	rename: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Workspace name is required' });
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ name, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'workspace.update',
				resource: 'workspace',
				resourceId: ws.id,
				workspaceId: ws.id,
				before: { name: ws.name },
				after: { name }
			});
		});
		return { renamed: name };
	},
	transfer: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		// Ownership transfer is owner-only on top of the workspace.write gate:
		// an admin holding workspace.write must not be able to evict the owner.
		if (locals.user!.id !== ws.ownerUserId) {
			return fail(403, { error: 'Only the workspace owner can transfer ownership' });
		}
		const form = await request.formData();
		const newOwnerId = String(form.get('newOwnerId') ?? '').trim();
		const [target] = await db
			.select({ userId: workspaceMember.userId })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, ws.id),
					eq(workspaceMember.userId, newOwnerId),
					eq(workspaceMember.status, 'active')
				)
			)
			.limit(1);
		if (!target) return fail(400, { error: 'New owner must be an active member of this workspace' });
		await db.transaction(async (tx) => {
			const [ownerRole] = await tx
				.select({ id: workspaceRole.id })
				.from(workspaceRole)
				.where(sql`${workspaceRole.workspaceId} IS NULL AND ${workspaceRole.name} = 'owner'`)
				.limit(1);
			const [adminRole] = await tx
				.select({ id: workspaceRole.id })
				.from(workspaceRole)
				.where(sql`${workspaceRole.workspaceId} IS NULL AND ${workspaceRole.name} = 'admin'`)
				.limit(1);
			await tx.update(workspace).set({ ownerUserId: newOwnerId, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
			await tx
				.update(workspaceMember)
				.set({ roleId: ownerRole.id, updatedAt: new Date() })
				.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.userId, newOwnerId)));
			await tx
				.update(workspaceMember)
				.set({ roleId: adminRole.id, updatedAt: new Date() })
				.where(and(eq(workspaceMember.workspaceId, ws.id), eq(workspaceMember.userId, ws.ownerUserId!)));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'workspace.transfer_owner',
				resource: 'workspace',
				resourceId: ws.id,
				workspaceId: ws.id,
				before: { owner_user_id: ws.ownerUserId },
				after: { owner_user_id: newOwnerId }
			});
		});
		return { transferred: true };
	},
	archive: async ({ locals }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ status: 'archived', updatedAt: new Date() }).where(eq(workspace.id, ws.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'workspace.archive',
				resource: 'workspace',
				resourceId: ws.id,
				workspaceId: ws.id,
				before: { status: ws.status },
				after: { status: 'archived' }
			});
		});
		return { archived: true };
	},
	restore: async ({ locals }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ status: 'active', updatedAt: new Date() }).where(eq(workspace.id, ws.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'workspace.restore',
				resource: 'workspace',
				resourceId: ws.id,
				workspaceId: ws.id,
				before: { status: ws.status },
				after: { status: 'active' }
			});
		});
		return { restored: true };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.delete');
		const form = await request.formData();
		const confirm = String(form.get('confirm') ?? '').trim();
		// PRD §109: typed confirmation names the exact workspace, and the
		// project check is a second, independent stopper — force is an explicit
		// opt-in past it, never the default.
		if (confirm !== ws.name) {
			return fail(400, { error: `Type the workspace name “${ws.name}” exactly to confirm deletion` });
		}
		const projectCount = await db.$count(project, eq(project.workspaceId, ws.id));
		if (projectCount > 0 && !form.get('force')) {
			return fail(400, {
				error: `This workspace still has ${projectCount} project(s). Delete or force-remove them first, or tick “force”.`
			});
		}
		await db.transaction(async (tx) => {
			// audit_log has no FK on workspace_id: the record of the deletion
			// survives the deletion itself.
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'workspace.delete',
				resource: 'workspace',
				resourceId: ws.id,
				workspaceId: ws.id,
				before: { name: ws.name, slug: ws.slug, status: ws.status },
				metadata: { forced: Boolean(form.get('force')), projectCount }
			});
			await tx.delete(workspace).where(eq(workspace.id, ws.id));
		});
		redirect(303, '/dashboard');
	},
	// The shell switchers (PRD §141) post here: one place owns the `fwid` /
	// `fpid` / `feid` cookies so a switch is a real membership-checked write,
	// never a client-side guess.
	switchWorkspace: async ({ locals, request, cookies }) => {
		requireCap(locals, 'member');
		const form = await request.formData();
		const targetId = String(form.get('workspaceId') ?? '').trim();
		const [member] = await db
			.select({ id: workspaceMember.id })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, targetId),
					eq(workspaceMember.userId, locals.user!.id),
					eq(workspaceMember.status, 'active')
				)
			)
			.limit(1);
		if (!member) return fail(403, { error: 'Not a member of that workspace' });
		cookies.set('fwid', targetId, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		// Project/environment ids are workspace-scoped: a stale pair would leak
		// the previous workspace's context into the new one.
		cookies.delete('fpid', { path: '/' });
		cookies.delete('feid', { path: '/' });
		redirect(303, '/dashboard');
	},
	switchProject: async ({ locals, request, cookies }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const form = await request.formData();
		const projectId = String(form.get('projectId') ?? '').trim();
		const [proj] = await db
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!proj) return fail(404, { error: 'Project not found' });
		const envs = await db
			.select({ id: environment.id })
			.from(environment)
			.where(eq(environment.projectId, proj.id))
			.orderBy(environment.createdAt)
			.limit(1);
		cookies.set('fpid', proj.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		if (envs.length) cookies.set('feid', envs[0].id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		else cookies.delete('feid', { path: '/' });
		redirect(303, `/dashboard/projects/${proj.id}`);
	},
	switchEnvironment: async ({ locals, request, cookies }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const form = await request.formData();
		const environmentId = String(form.get('environmentId') ?? '').trim();
		const [env] = await db
			.select({ id: environment.id, projectId: environment.projectId })
			.from(environment)
			.innerJoin(project, eq(project.id, environment.projectId))
			.where(and(eq(environment.id, environmentId), eq(project.workspaceId, workspaceId)))
			.limit(1);
		if (!env) return fail(404, { error: 'Environment not found' });
		cookies.set('feid', env.id, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		cookies.set('fpid', env.projectId, { path: '/', maxAge: 31536000, sameSite: 'lax' });
		redirect(303, `/dashboard/projects/${env.projectId}/environments`);
	}
};
