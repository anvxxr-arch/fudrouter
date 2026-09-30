import { and, desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { auditRowsForDisplay } from '$lib/server/admin-audit-view';
import { db } from '$lib/server/db';
import { auditLog, user } from '$lib/server/db/schema';

const PAGE = 100;

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.audit');
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const action = url.searchParams.get('action')?.trim();
	const conditions = [action ? eq(auditLog.action, action) : undefined];
	const rows = await db
		.select({
			id: auditLog.id,
			actorUserId: auditLog.actorUserId,
			actorKind: auditLog.actorKind,
			actorEmail: user.email,
			action: auditLog.action,
			resource: auditLog.resource,
			resourceId: auditLog.resourceId,
			workspaceId: auditLog.workspaceId,
			ip: auditLog.ip,
			before: auditLog.before,
			after: auditLog.after,
			metadata: auditLog.metadata,
			createdAt: auditLog.createdAt
		})
		.from(auditLog)
		.leftJoin(user, eq(user.id, auditLog.actorUserId))
		.where(and(...conditions))
		.orderBy(desc(auditLog.createdAt))
		.limit(PAGE)
		.offset((page - 1) * PAGE);
	// Distinct actions for the filter dropdown — data, not a hardcoded list.
	const actions = await db
		.select({ action: auditLog.action, n: sql<number>`count(*)::int` })
		.from(auditLog)
		.groupBy(auditLog.action)
		.orderBy(desc(sql`count(*)`))
		.limit(30);
	return {
		// Secrets never reach the page: redacted keys are dropped, not shown
		// as '[redacted]' (PRD §71, §137).
		rows: auditRowsForDisplay(rows),
		actions,
		page,
		action: action ?? ''
	};
};
