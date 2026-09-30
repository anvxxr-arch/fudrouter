import { json, type RequestHandler } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requestLog } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { likePattern, paletteParams } from '$lib/server/palette';
import type { PaletteItem } from '$lib/palette';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	const { q, limit } = paletteParams(url);
	if (!workspaceId) return json({ items: [] as PaletteItem[] });
	await requireMemberPermission(locals, workspaceId, 'request.read');
	// A request lookup is an id lookup — a 3-char floor keeps the log table out
	// of fuzzy "search everything" queries while prefix search stays instant.
	if (q.length < 3) return json({ items: [] as PaletteItem[] });
	const pattern = likePattern(q, 'prefix');
	const rows = await db
		.select({
			id: requestLog.id,
			status: requestLog.status,
			endpoint: requestLog.endpoint,
			createdAt: requestLog.createdAt
		})
		.from(requestLog)
		.where(sql`${requestLog.id} ilike ${pattern}`)
		.orderBy(desc(requestLog.createdAt))
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'request',
				title: r.id,
				subtitle: `${r.status} · ${r.endpoint ?? '—'}`,
				href: '/dashboard/usage'
			})
		)
	});
};
