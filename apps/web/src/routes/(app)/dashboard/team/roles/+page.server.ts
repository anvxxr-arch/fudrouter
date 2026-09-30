import { fail, redirect } from '@sveltejs/kit';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { workspaceMember, workspaceRole } from '$lib/server/db/schema';
import {
	ALL_WORKSPACE_PERMISSIONS,
	currentWorkspaceId,
	isWorkspacePermission,
	requireMemberPermission,
	type WorkspacePermission
} from '$lib/server/rbac';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { ID_PREFIXES, newId } from '$lib/server/id';
// Team roles (spec §2, PRD §45/§46): builtin templates (workspace_id NULL) are
// read-only references; a workspace can add custom roles as rows — a collection
// of permission codes, so RBAC needs no schema change. Editing is one form: the
// complete permission list as checkboxes grouped by resource prefix.
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) return { roles: [], permissions: [], groups: [] };
	const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'member.read');
	const roles = await db
		.select({
			id: workspaceRole.id,
			name: workspaceRole.name,
			workspaceId: workspaceRole.workspaceId,
			permissions: workspaceRole.permissions,
			createdAt: workspaceRole.createdAt
		})
		.from(workspaceRole)
		.where(or(isNull(workspaceRole.workspaceId), eq(workspaceRole.workspaceId, ws.id)))
		.orderBy(workspaceRole.createdAt);
	const usage = await db
		.select({ roleId: workspaceMember.roleId })
		.from(workspaceMember)
		.where(eq(workspaceMember.workspaceId, ws.id));
	const memberCounts = new Map<string, number>();
	for (const row of usage) memberCounts.set(row.roleId, (memberCounts.get(row.roleId) ?? 0) + 1);
	// One pass over the pinned code list builds both the flat select-all list
	// and the grouped checkbox layout (`key.read` → group `key`).
	const groups: { prefix: string; codes: WorkspacePermission[] }[] = [];
	for (const code of ALL_WORKSPACE_PERMISSIONS) {
		const prefix = code.split('.')[0];
		const last = groups[groups.length - 1];
		if (last && last.prefix === prefix) last.codes.push(code);
		else groups.push({ prefix, codes: [code] });
	}
	return {
		roles: roles.map((r) => ({
			id: r.id,
			name: r.name,
			custom: r.workspaceId !== null,
			permissions: (r.permissions ?? []).filter(isWorkspacePermission),
			memberCount: memberCounts.get(r.id) ?? 0
		})),
		permissions: ALL_WORKSPACE_PERMISSIONS,
		groups
	};
};
export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'Role name is required' });
		const permissions = ALL_WORKSPACE_PERMISSIONS.filter(
			(p: WorkspacePermission) => form.get(p) === 'on'
		);
		const existing = await db
			.select({ name: workspaceRole.name })
			.from(workspaceRole)
			.where(or(isNull(workspaceRole.workspaceId), eq(workspaceRole.workspaceId, ws.id)));
		if (existing.some((r) => r.name === name)) {
			return fail(400, { error: `A role named “${name}” already exists` });
		}
		await db.transaction(async (tx) => {
			await tx.insert(workspaceRole).values({
				id: newId(ID_PREFIXES.workspaceRole),
				workspaceId: ws.id,
				name,
				permissions
			});
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'role.create',
				resource: 'workspace_role',
				workspaceId: ws.id,
				after: { name, permissions },
				metadata: { name, permissionCount: permissions.length }
			});
		});
		return { created: name };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		const form = await request.formData();
		const roleId = String(form.get('roleId') ?? '').trim();
		const [role] = await db
			.select()
			.from(workspaceRole)
			.where(and(eq(workspaceRole.id, roleId), eq(workspaceRole.workspaceId, ws.id)))
			.limit(1);
		// Builtins are templates: the (workspace_id) constraint in the WHERE
		// already excludes them, but the message names the reason.
		if (!role) return fail(400, { error: 'Only custom roles can be edited' });
		const permissions = ALL_WORKSPACE_PERMISSIONS.filter(
			(p: WorkspacePermission) => form.get(p) === 'on'
		);
		await db.transaction(async (tx) => {
			await tx
				.update(workspaceRole)
				.set({ permissions })
				.where(eq(workspaceRole.id, role.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'role.update',
				resource: 'workspace_role',
				resourceId: role.id,
				workspaceId: ws.id,
				before: { name: role.name, permissions: role.permissions },
				after: { name: role.name, permissions }
			});
		});
		return { saved: role.name };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) redirect(303, '/dashboard');
		const { workspace: ws } = await requireMemberPermission(locals, workspaceId, 'workspace.write');
		const form = await request.formData();
		const roleId = String(form.get('roleId') ?? '').trim();
		const [role] = await db
			.select()
			.from(workspaceRole)
			.where(and(eq(workspaceRole.id, roleId), eq(workspaceRole.workspaceId, ws.id)))
			.limit(1);
		if (!role) return fail(400, { error: 'Only custom roles can be deleted' });
		const confirm = String(form.get('confirm') ?? '').trim();
		if (confirm !== role.name) {
			return fail(400, { error: `Type the role name “${role.name}” exactly to confirm deletion` });
		}
		// A role in use is not deletable (the FK is RESTRICT, checked here for a
		// human message): move those members first.
		const inUse = await db.$count(workspaceMember, eq(workspaceMember.roleId, role.id));
		if (inUse > 0) {
			return fail(400, { error: `Move the ${inUse} member(s) still on “${role.name}” first` });
		}
		await db.transaction(async (tx) => {
			await tx.delete(workspaceRole).where(eq(workspaceRole.id, role.id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'role.delete',
				resource: 'workspace_role',
				resourceId: role.id,
				workspaceId: ws.id,
				before: { name: role.name, permissions: role.permissions }
			});
		});
		return { deleted: role.name };
	}
};
