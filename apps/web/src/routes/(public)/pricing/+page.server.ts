import type { PageServerLoad } from './$types';
import { servedModels, type CatalogModel } from '$lib/server/public-catalog';

// Pricing (PRD §14/§15) — the normalized per-1M price list, straight from the
// pricing rules servedModels() resolves (the same publish gate as the router).
// Grouped by developer so a buyer can scan "what does this lab cost" before
// drilling into a model. The legacy `model.input_price` columns and the
// placeholder tier map are gone: this page quotes only what billing would use.

export const load: PageServerLoad = async () => {
	const models = await servedModels();
	// Group by developer; a model with no developer lands under "Unknown" —
	// absence of data is not a zero (PRD §122), but the row still belongs to a group.
	const groups = new Map<string, CatalogModel[]>();
	for (const m of models) {
		const key = m.developer ?? 'Unknown';
		const list = groups.get(key);
		if (list) list.push(m);
		else groups.set(key, [m]);
	}
	const developers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
	return {
		groups: developers.map((developer) => ({
			developer,
			models: groups
				.get(developer)!
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((m) => ({
					slug: m.slug,
					name: m.name,
					price: m.price,
					context: m.context,
					// Any provider whose specific rule differs from the model-wide one
					// means the single number below would be wrong for that route.
					variesByProvider: m.providers.some((p) => p.price !== null)
				}))
		})),
		// The reasoning column exists only when some model carries one — a column
		// of em-dashes is noise.
		hasReasoning: models.some((m) => m.price.reasoningPriceMicro !== null)
	};
};
