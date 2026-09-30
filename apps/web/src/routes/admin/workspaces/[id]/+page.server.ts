import { error, fail } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { writeAudit } from '$lib/server/audit';
import { balanceMicro } from '$lib/server/billing';
import { db } from '$lib/server/db';
import {
	billingAccount,
	project,
	requestLog,
	user,
	workspace,
	workspaceMember,
	workspaceRole
} from '$lib/server/db/schema';
const WORKSPACE_STATUSES = ['active', 'archived', 'suspended'] as const;
export const load: PageServerLoad = async ({ locals, params }) => {
	requireCap(locals, 'admin.users');
	const [ws] = await db
		.select({
			id: workspace.id,
			name: workspace.name,
			slug: workspace.slug,
			status: workspace.status,
			settings: workspace.settings,
			createdAt: workspace.createdAt,
			updatedAt: workspace.updatedAt,
			ownerId: workspace.ownerUserId,
			ownerEmail: user.email
		})
		.from(workspace)
		.leftJoin(user, eq(user.id, workspace.ownerUserId))
		.where(eq(workspace.id, params.id))
		.limit(1);
	if (!ws) error(404, 'Workspace not found');
	const id = ws.id;
	const members = await db
		.select({
			memberId: workspaceMember.id,
			userId: workspaceMember.userId,
			userEmail: user.email,
			userName: user.name,
			role: workspaceRole.name,
			status: workspaceMember.status
		})
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(eq(workspaceMember.workspaceId, id))
		.orderBy(user.email);
	const projects = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: project.status,
			createdAt: project.createdAt
		})
		.from(project)
		.where(eq(project.workspaceId, id))
		.orderBy(project.name);
	const [usage] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			tokensIn: sql<number>`coalesce(sum(${requestLog.tokensIn}), 0)::int`,
			tokensOut: sql<number>`coalesce(sum(${requestLog.tokensOut}), 0)::int`,
			cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
		})
		.from(requestLog)
		.where(eq(requestLog.workspaceId, id));
	const [account] = await db
		.select({
			accountId: billingAccount.id,
			currency: billingAccount.currency,
			status: billingAccount.status,
			cachedBalanceMicro: billingAccount.balanceMicro
		})
		.from(billingAccount)
		.where(eq(billingAccount.workspaceId, id))
		.limit(1);
	const billing = account
		? { ...account, balanceMicro: await balanceMicro(account.accountId) }
		: null;
	return {
		workspace: ws,
		members,
		projects,
		usage: usage ?? { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' },
		billing,
		statuses: WORKSPACE_STATUSES
	};
};
export const actions: Actions = {
	setStatus: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const status = String(form.get('status') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing workspace id' });
		if (!(WORKSPACE_STATUSES as readonly string[]).includes(status)) {
			return fail(400, { error: 'Invalid status' });
		}
		const [target] = await db
			.select({ status: workspace.status })
			.from(workspace)
			.where(eq(workspace.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'Workspace not found' });
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ status }).where(eq(workspace.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'workspace.status_set',
				resource: 'workspace',
				resourceId: id,
				workspaceId: id,
				before: { status: target.status },
				after: { status }
			});
		});
		return { statusSet: id };
	},
	suspend: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing workspace id' });
		const [target] = await db
			.select({ status: workspace.status })
			.from(workspace)
			.where(eq(workspace.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'Workspace not found' });
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ status: 'suspended' }).where(eq(workspace.id, id));
			// Suspension takes the workspace's projects with it — same transaction,
			// so a project can never stay live under a suspended workspace.
			const suspended = await tx
				.update(project)
				.set({ status: 'suspended' })
				.where(eq(project.workspaceId, id))
				.returning({ id: project.id });
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'workspace.suspend',
				resource: 'workspace',
				resourceId: id,
				workspaceId: id,
				before: { status: target.status },
				after: { status: 'suspended' },
				metadata: { projectsSuspended: suspended.map((p) => p.id) }
			});
		});
		return { suspended: id };
	},
	unsuspend: async ({ locals, request }) => {
		requireCap(locals, 'admin.users');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing workspace id' });
		const [target] = await db
			.select({ status: workspace.status })
			.from(workspace)
			.where(eq(workspace.id, id))
			.limit(1);
		if (!target) return fail(404, { error: 'Workspace not found' });
		await db.transaction(async (tx) => {
			await tx.update(workspace).set({ status: 'active' }).where(eq(workspace.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'workspace.unsuspend',
				resource: 'workspace',
				resourceId: id,
				workspaceId: id,
				before: { status: target.status },
				after: { status: 'active' }
			});
		});
		return { unsuspended: id };
	}
};
