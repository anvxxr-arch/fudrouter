import { json, type RequestHandler } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workspace, workspaceMember } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId } from '$lib/server/rbac';
import { likePattern, paletteParams } from '$lib/server/palette';
import type { PaletteItem } from '$lib/palette';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const { q, limit } = paletteParams(url);
	const userId = locals.user!.id;
	const pattern = likePattern(q);
	// Memberships only — the workspace switch action re-checks membership
	// server-side, so this list can never widen what a switch can reach.
	const rows = await db
		.select({ id: workspace.id, name: workspace.name, slug: workspace.slug })
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(
			and(
				eq(workspaceMember.userId, userId),
				eq(workspaceMember.status, 'active'),
				q
					? sql`${workspace.name} ilike ${pattern} or ${workspace.slug} ilike ${pattern}`
					: sql`true`
			)
		)
		.orderBy(workspace.name)
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'workspace',
				title: r.name,
				subtitle: r.slug,
				href: '/dashboard/workspace'
			})
		)
	});
};
