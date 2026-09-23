import { asc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { buildCatalog } from '$lib/catalog';
import { reachability } from '$lib/publish';
import { allowDevProviders } from '$lib/server/publish';
import { db } from '$lib/server/db';
import { model, provider } from '$lib/server/db/schema';

// Public page: only model identity + pricing. Never provider names or URLs.
// Prices are per 1M tokens (PAYG); the tier column comes from $lib/catalog.
//
// Same publish gate as /models and the data plane: a price list quoting a slug
// the router refuses is worse than a shorter list.
export const load: PageServerLoad = async () => {
	const allowDev = allowDevProviders();

	const rows = await db
		.select({
			slug: model.slug,
			name: model.name,
			context: model.context,
			inputPrice: model.inputPrice,
			outputPrice: model.outputPrice,
			currency: model.currency,
			modelStatus: model.status,
			providerStatus: provider.status
		})
		.from(model)
		.innerJoin(provider, eq(provider.id, model.providerId))
		.orderBy(asc(model.slug));

	const served = rows
		.filter((r) => reachability(r.modelStatus, r.providerStatus, allowDev).served)
		.map(({ slug, name, context, inputPrice, outputPrice, currency }) => ({
			slug,
			name,
			context,
			inputPrice,
			outputPrice,
			currency
		}));

	return { catalog: buildCatalog(served) };
};
