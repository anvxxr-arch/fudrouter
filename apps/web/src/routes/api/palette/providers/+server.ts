import { json, type RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { provider } from '$lib/server/db/schema';
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
		.select({ id: provider.id, name: provider.name, slug: provider.slug })
		.from(provider)
		.where(
			q
				? sql`${provider.name} ilike ${pattern} or ${provider.slug} ilike ${pattern}`
				: sql`true`
		)
		.orderBy(provider.name)
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'provider',
				title: r.name,
				subtitle: r.slug ?? '',
				href: '/models'
			})
		)
	});
};
