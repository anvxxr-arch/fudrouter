import { eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { apiKey, environment, project, requestLog, workspace } from '$lib/server/db/schema';
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.users');
	const rows = await db
		.select({
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: project.status,
			workspaceName: workspace.name,
			createdAt: project.createdAt
		})
		.from(project)
		.innerJoin(workspace, eq(workspace.id, project.workspaceId))
		.orderBy(workspace.name, project.name);
	const projIds = rows.map((r) => r.id);
	const usageByProj = new Map<string, { requests: number; cost: string }>(
		projIds.map((id) => [id, { requests: 0, cost: '0' }])
	);
	const envByProj = new Map<string, number>(projIds.map((id) => [id, 0]));
	const keyByProj = new Map<string, number>(projIds.map((id) => [id, 0]));
	if (projIds.length > 0) {
		const usage = await db
			.select({
				projectId: requestLog.projectId,
				requests: sql<number>`count(*)::int`,
				cost: sql<string>`coalesce(sum(${requestLog.cost}), 0)::text`
			})
			.from(requestLog)
			.where(sql`${requestLog.projectId} = any(${projIds})`)
			.groupBy(requestLog.projectId);
		for (const u of usage) if (u.projectId) usageByProj.set(u.projectId, u);
		const envs = await db
			.select({ projectId: environment.projectId, n: sql<number>`count(*)::int` })
			.from(environment)
			.where(sql`${environment.projectId} = any(${projIds})`)
			.groupBy(environment.projectId);
		for (const e of envs) envByProj.set(e.projectId, e.n);
		const keys = await db
			.select({ projectId: apiKey.projectId, n: sql<number>`count(*)::int` })
			.from(apiKey)
			.where(sql`${apiKey.projectId} = any(${projIds})`)
			.groupBy(apiKey.projectId);
		for (const k of keys) if (k.projectId) keyByProj.set(k.projectId, k.n);
	}
	return {
		projects: rows.map((r) => ({
			...r,
			environments: envByProj.get(r.id) ?? 0,
			keys: keyByProj.get(r.id) ?? 0,
			requests: usageByProj.get(r.id)?.requests ?? 0,
			cost: usageByProj.get(r.id)?.cost ?? '0'
		}))
	};
};
