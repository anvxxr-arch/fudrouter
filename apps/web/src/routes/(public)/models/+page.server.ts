import type { PageServerLoad } from './$types';
import { servedModels } from '$lib/server/public-catalog';
import { parseCompareList } from '$lib/compare';
import {
	applyFilters,
	filterOptions,
	sortModels,
	type CatalogFilters,
	type SortKey
} from '$lib/model-catalog';
import type { CapabilityKey } from '$lib/capabilities';

// Public catalog: the ONE query layer (servedModels) joins model +
// provider_model + provider + pricing_rule and applies the same publish gate
// the data plane serves, so this page cannot advertise a slug the router would
// refuse. Provider names appear here by design (PRD §14 "provider availability");
// credential material never crosses the boundary.

/** Tri-state capability filters surfaced as form fields on the catalog. */
const CAPABILITY_FILTERS = [
	'vision',
	'tools',
	'reasoning',
	'structured_output',
	'streaming'
] as const;

const SORT_KEYS = [
	'name',
	'input-price',
	'output-price',
	'context',
	'popularity',
	'latency',
	'availability'
] as const satisfies readonly SortKey[];

/**
 * URL query params are strings; the filter layer speaks numbers and micro-unit
 * bigints. The raw strings are ALSO returned so the form can round-trip what
 * the visitor typed instead of a re-serialised interpretation of it.
 */
function parseFilters(query: URLSearchParams): { filters: CatalogFilters; form: Record<string, string> } {
	const form: Record<string, string> = {
		search: query.get('search')?.trim() ?? '',
		developer: query.get('developer')?.trim() ?? '',
		provider: query.get('provider')?.trim() ?? '',
		minContext: query.get('minContext')?.trim() ?? '',
		maxInputPrice: query.get('maxInputPrice')?.trim() ?? '',
		maxOutputPrice: query.get('maxOutputPrice')?.trim() ?? ''
	};
	// "min context (k tokens)" is the stated unit of the field.
	const minContext = form.minContext ? Number(form.minContext) * 1000 : NaN;
	/**
	 * The form asks for a currency amount per 1M tokens ("1.25"); the data layer
	 * counts MICRO-units per 1M ("1250000.000000"). Scale in integer math only —
	 * money never touches a float.
	 */
	const price = (raw: string): bigint | null => {
		if (!/^\d+(\.\d{1,6})?$/.test(raw)) return null;
		const [whole = '0', frac = ''] = raw.split('.');
		return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
	};
	const capabilities: CatalogFilters['capabilities'] = {};
	for (const key of CAPABILITY_FILTERS) {
		const raw = query.get(key)?.trim() ?? 'any';
		const want = raw === 'yes' || raw === 'no' ? raw : 'any';
		form[key] = want;
		if (want !== 'any') capabilities[key as CapabilityKey] = want;
	}
	return {
		filters: {
			search: form.search,
			developer: form.developer,
			provider: form.provider,
			minContext: Number.isFinite(minContext) && minContext > 0 ? Math.round(minContext) : null,
			maxInputPriceMicro: price(form.maxInputPrice),
			maxOutputPriceMicro: price(form.maxOutputPrice),
			capabilities
		},
		form
	};
}

export const load: PageServerLoad = async ({ url }) => {
	const models = await servedModels();
	const { filters, form } = parseFilters(url.searchParams);
	const sortParam = url.searchParams.get('sort');
	const sort: SortKey = (SORT_KEYS as readonly string[]).includes(sortParam ?? '')
		? (sortParam as SortKey)
		: 'name';
	const rows = sortModels(applyFilters(models, filters), sort);
	// The compare selection accumulates through the URL (?compare=a,b,c) so it
	// survives a filter submit and a share; the checkboxes read and write it.
	// parseCompareList applies the same dedupe/cap as the compare page.
	const { slugs: selected } = parseCompareList(url.searchParams.get('compare'));
	return {
		models: rows,
		total: models.length,
		selected,
		options: filterOptions(models),
		form,
		sort
	};
};
