import { asc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { buildCatalog } from '$lib/catalog';
import { db } from '$lib/server/db';
import { model } from '$lib/server/db/schema';

// Public page: only model identity + pricing. Never provider names or URLs.
// Prices are per 1M tokens (PAYG); the tier column comes from $lib/catalog.
export const load: PageServerLoad = async () => {
	const rows = await db
		.select({
			slug: model.slug,
			name: model.name,
			context: model.context,
			inputPrice: model.inputPrice,
			outputPrice: model.outputPrice,
			currency: model.currency
		})
		.from(model)
		.where(eq(model.status, 'active'))
		.orderBy(asc(model.slug));
	return { catalog: buildCatalog(rows) };
};
