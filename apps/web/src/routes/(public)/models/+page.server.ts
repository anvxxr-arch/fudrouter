import { asc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { buildCatalog } from '$lib/catalog';
import { db } from '$lib/server/db';
import { model } from '$lib/server/db/schema';

// Public page: model identity only — never provider names or URLs. The
// surface/tier assignment comes from $lib/catalog (placeholder today).
export const load: PageServerLoad = async () => {
	const rows = await db
		.select({ slug: model.slug, name: model.name, context: model.context })
		.from(model)
		.where(eq(model.status, 'active'))
		.orderBy(asc(model.slug));
	return { catalog: buildCatalog(rows) };
};
