import { json, type RequestHandler } from '@sveltejs/kit';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiKey } from '$lib/server/db/schema';
import { requireCap } from '$lib/server/roles';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { likePattern, paletteParams } from '$lib/server/palette';
import type { PaletteItem } from '$lib/palette';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	const { q, limit } = paletteParams(url);
	if (!workspaceId) return json({ items: [] as PaletteItem[] });
	await requireMemberPermission(locals, workspaceId, 'key.read');
	const pattern = likePattern(q);
	const rows = await db
		.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, status: apiKey.status })
		.from(apiKey)
		.where(
			and(
				eq(apiKey.userId, locals.user!.id),
				// Playground run keys are one-shot plumbing (PRD §27), not a
				// customer's key list — they would crowd out real rows.
				sql`(${apiKey.policy} ->> 'playground') is distinct from 'true'`,
				q
					? sql`${apiKey.name} ilike ${pattern} or ${apiKey.prefix} ilike ${pattern}`
					: sql`true`
			)
		)
		.orderBy(apiKey.createdAt)
		.limit(limit);
	return json({
		items: rows.map(
			(r): PaletteItem => ({
				id: r.id,
				type: 'key',
				title: r.name,
				subtitle: `${r.prefix}… · ${r.status}`,
				href: '/dashboard/keys'
			})
		)
	});
};
