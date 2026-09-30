/**
 * Model catalog pure logic — filtering and sorting for /models.
 *
 * Split from the page so the rules are unit-testable without a SvelteKit load:
 * the page collects query params and calls `applyFilters` + `sortModels`.
 */
import type { CatalogModel } from '$lib/server/public-catalog';
import { effectiveCapability, matchesCapability, type CapabilityKey } from '$lib/capabilities';

export type SortKey =
	| 'name'
	| 'input-price'
	| 'output-price'
	| 'context'
	| 'popularity'
	| 'latency'
	| 'availability';

export interface CatalogFilters {
	search: string;
	developer: string; // '' = all
	provider: string; // provider name, '' = all
	minContext: number | null;
	maxInputPriceMicro: bigint | null; // per 1M, inclusive
	maxOutputPriceMicro: bigint | null;
	capabilities: Partial<Record<CapabilityKey, 'any' | 'yes' | 'no'>>;
}

export const EMPTY_FILTERS: CatalogFilters = {
	search: '',
	developer: '',
	provider: '',
	minContext: null,
	maxInputPriceMicro: null,
	maxOutputPriceMicro: null,
	capabilities: {}
};

function inputPriceMicro(m: CatalogModel): bigint {
	return BigInt(m.price.inputPriceMicro.split('.')[0] ?? '0');
}
function outputPriceMicro(m: CatalogModel): bigint {
	return BigInt((m.price.outputPriceMicro ?? '0').split('.')[0] ?? '0');
}

export function applyFilters(models: CatalogModel[], f: CatalogFilters): CatalogModel[] {
	return models.filter((m) => {
		if (f.search) {
			const q = f.search.toLowerCase();
			const hay = `${m.name} ${m.slug} ${m.developer ?? ''} ${m.family ?? ''}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		if (f.developer && (m.developer ?? '') !== f.developer) return false;
		if (f.provider && !m.providers.some((p) => p.providerName === f.provider)) return false;
		if (f.minContext !== null && (m.context ?? 0) < f.minContext) return false;
		if (f.maxInputPriceMicro !== null && inputPriceMicro(m) > f.maxInputPriceMicro) return false;
		if (f.maxOutputPriceMicro !== null && outputPriceMicro(m) > f.maxOutputPriceMicro) return false;
		for (const key of Object.keys(f.capabilities) as CapabilityKey[]) {
			const want = f.capabilities[key];
			if (!want || want === 'any') continue;
			// Model-level effective capability (canonical; per-provider overrides
			// surface on the detail page's Provider Availability table).
			if (!matchesCapability(effectiveCapability(m.capabilities, {}, key), want)) return false;
		}
		return true;
	});
}

export function sortModels(models: CatalogModel[], key: SortKey): CatalogModel[] {
	const out = [...models];
	// Nulls sort LAST whichever direction the key implies: no data is not a zero.
	const cmpNum = (a: number | null, b: number | null, dir: 1 | -1): number => {
		if (a === null && b === null) return 0;
		if (a === null) return 1;
		if (b === null) return -1;
		return (a - b) * dir;
	};
	switch (key) {
		case 'name':
			out.sort((a, b) => a.name.localeCompare(b.name));
			break;
		case 'input-price':
			out.sort((a, b) =>
				inputPriceMicro(a) < inputPriceMicro(b)
					? -1
					: inputPriceMicro(a) > inputPriceMicro(b)
						? 1
						: 0
			);
			break;
		case 'output-price':
			out.sort((a, b) =>
				outputPriceMicro(a) < outputPriceMicro(b)
					? -1
					: outputPriceMicro(a) > outputPriceMicro(b)
						? 1
						: 0
			);
			break;
		case 'context':
			out.sort((a, b) => cmpNum(a.context, b.context, -1));
			break;
		case 'popularity':
			// No public request-count exists yet, so "popularity" orders by
			// provider breadth (how many routes serve the model) then name —
			// the honest proxy until traffic figures are exposed.
			out.sort((a, b) => b.providers.length - a.providers.length || a.name.localeCompare(b.name));
			break;
		case 'latency':
			out.sort((a, b) => cmpNum(a.p50Ms, b.p50Ms, 1));
			break;
		case 'availability':
			out.sort((a, b) => cmpNum(a.availability, b.availability, -1));
			break;
	}
	return out;
}

/** Distinct option lists for the filter selects. */
export function filterOptions(models: CatalogModel[]): {
	developers: string[];
	providers: string[];
} {
	const developers = [
		...new Set(models.map((m) => m.developer).filter((d): d is string => !!d))
	].sort();
	const providers = [
		...new Set(models.flatMap((m) => m.providers.map((p) => p.providerName)))
	].sort();
	return { developers, providers };
}
