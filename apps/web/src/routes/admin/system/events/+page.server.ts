import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { systemEvent } from '$lib/server/db/schema';
import { cleanField } from '$lib/server/admin-vocab';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireCap(locals, 'admin.ops');
	const type = cleanField(url.searchParams.get('type'), 120);

	const rows = await db
		.select({
			id: systemEvent.id,
			type: systemEvent.type,
			resource: systemEvent.resource,
			resourceId: systemEvent.resourceId,
			workspaceId: systemEvent.workspaceId,
			metadata: systemEvent.metadata,
			createdAt: systemEvent.createdAt
		})
		.from(systemEvent)
		.where(type ? eq(systemEvent.type, type) : undefined)
		.orderBy(desc(systemEvent.createdAt))
		.limit(200);

	const distinct = await db
		.selectDistinct({ type: systemEvent.type })
		.from(systemEvent)
		.orderBy(systemEvent.type);
	// `select distinct` + order by expression for exactness on older paths.
	const types = distinct.map((d) => d.type).sort();

	return { rows, types, type: type ?? '' };
};
