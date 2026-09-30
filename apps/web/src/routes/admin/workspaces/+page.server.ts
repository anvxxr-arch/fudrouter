import { eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { balanceMicro } from '$lib/server/billing';
import { db } from '$lib/server/db';
import {
	billingAccount,
	project,
	requestLog,
	user,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.users');
	const rows = await db
		.select({
			id: workspace.id,
			name: workspace.name,
			slug: workspace.slug,
			status: workspace.status,
			ownerEmail: user.email,
			createdAt: workspace.createdAt
		})
		.from(workspace)
		.leftJoin(user, eq(user.id, workspace.ownerUserId))
		.orderBy(workspace.name);
	const wsIds = rows.map((r) => r.id);
	const usageByWs = new Map<string, { requests: number; cost: string }>(
		wsIds.map((id) => [id, { requests: 0, cost: '0' }])
	);
	const memberByWs = new Map<string, number>(wsIds.map((id) => [id, 0]));
	const projByWs = new Map<string, number>(wsIds.map((id) => [id, 0]));
	const balanceByWs = new Map<string, bigint>(wsIds.map((id) => [id, 0n]));
	if (wsIds.length > 0) {
		const usage = await db
			.select({
				workspaceId: requestLog.workspaceId,
				requests: sql<number>`count(*)::int`,
				cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
			})
			.from(requestLog)
			.where(sql`${requestLog.workspaceId} = any(${wsIds})`)
			.groupBy(requestLog.workspaceId);
		for (const u of usage) if (u.workspaceId) usageByWs.set(u.workspaceId, u);
		const members = await db
			.select({ workspaceId: workspaceMember.workspaceId, n: sql<number>`count(*)::int` })
			.from(workspaceMember)
			.where(sql`${workspaceMember.workspaceId} = any(${wsIds})`)
			.groupBy(workspaceMember.workspaceId);
		for (const m of members) memberByWs.set(m.workspaceId, m.n);
		const projs = await db
			.select({ workspaceId: project.workspaceId, n: sql<number>`count(*)::int` })
			.from(project)
			.where(sql`${project.workspaceId} = any(${wsIds})`)
			.groupBy(project.workspaceId);
		for (const p of projs) projByWs.set(p.workspaceId, p.n);
		const accounts = await db
			.select({ workspaceId: billingAccount.workspaceId, id: billingAccount.id })
			.from(billingAccount)
			.where(sql`${billingAccount.workspaceId} = any(${wsIds})`);
		for (const a of accounts) balanceByWs.set(a.workspaceId, await balanceMicro(a.id));
	}
	return {
		workspaces: rows.map((r) => ({
			...r,
			members: memberByWs.get(r.id) ?? 0,
			projects: projByWs.get(r.id) ?? 0,
			requests: usageByWs.get(r.id)?.requests ?? 0,
			cost: usageByWs.get(r.id)?.cost ?? '0',
			balanceMicro: balanceByWs.get(r.id) ?? 0n
		}))
	};
};
