import { json, type RequestHandler } from '@sveltejs/kit';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { project } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { likePattern, paletteParams } from '$lib/server/palette';
import type { PaletteItem } from '$lib/palette';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	const { q, limit } = paletteParams(url);
	if (!workspaceId) return json({ items: [] as PaletteItem[] });
	await requireMemberPermission(locals, workspaceId, 'project.read');
	const pattern = likePattern(q);
	const rows = await db
		.select({ id: project.id, name: project.name, slug: project.slug })
		.from(project)
		.where(
			and(
				eq(project.workspaceId, workspaceId),
				q ? sql`${project.name} ilike ${pattern} or ${project.slug} ilike ${pattern}` : sql`true`
			)
		)
		.orderBy(project.name)
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'project',
				title: r.name,
				subtitle: r.slug,
				href: `/dashboard/projects/${r.id}`
			})
		)
	});
};
