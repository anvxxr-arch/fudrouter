import { json, type RequestHandler } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { model } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { likePattern, paletteParams } from '$lib/server/palette';
import type { PaletteItem } from '$lib/palette';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	const { q, limit } = paletteParams(url);
	if (!workspaceId) return json({ items: [] as PaletteItem[] });
	await requireMemberPermission(locals, workspaceId, 'workspace.read');
	const pattern = likePattern(q);
	const rows = await db
		.select({ id: model.id, slug: model.slug, name: model.name, developer: model.developer })
		.from(model)
		.where(
			sql`${model.status} = 'active' and ${
				q
					? sql`${model.slug} ilike ${pattern} or ${model.name} ilike ${pattern} or ${model.developer} ilike ${pattern}`
					: sql`true`
			}`
		)
		.orderBy(model.slug)
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'model',
				title: r.slug,
				subtitle: r.developer ? `${r.name} · ${r.developer}` : r.name,
				href: '/models'
			})
		)
	});
};
