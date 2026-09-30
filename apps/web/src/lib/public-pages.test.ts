import { describe, expect, it } from 'vitest';
import { CAPABILITIES, effectiveCapability, matchesCapability } from './capabilities';
import { componentOf, stateFor, STATUS_COMPONENTS } from './status';
import { parseCompareList, addToCompare, MAX_COMPARE } from './compare';
import { applyFilters, sortModels, EMPTY_FILTERS } from './model-catalog';
import type { CatalogModel } from '$lib/server/public-catalog';

const model = (over: Partial<CatalogModel>): CatalogModel => ({
	id: 'mdl_a',
	slug: 'a',
	name: 'Model A',
	family: null,
	developer: 'Dev',
	description: null,
	context: 1000,
	maxOutput: null,
	modality: {},
	capabilities: {},
	status: 'active',
	currency: 'USD',
	price: {
		inputPriceMicro: '1000000.000000',
		cachedInputPriceMicro: null,
		outputPriceMicro: '2000000.000000',
		reasoningPriceMicro: null,
		currency: 'USD'
	},
	providers: [],
	p50Ms: null,
	p95Ms: null,
	availability: null,
	...over
});

describe('capability vocabulary', () => {
	it('treats a missing key as unknown, not as no', () => {
		expect(effectiveCapability({}, {}, 'vision')).toBeNull();
	});
	it('lets a provider override the canonical value', () => {
		expect(effectiveCapability({ vision: true }, { vision: false }, 'vision')).toBe(false);
	});
	it('filters on the tri-state', () => {
		expect(matchesCapability(true, 'yes')).toBe(true);
		expect(matchesCapability(null, 'yes')).toBe(false);
		expect(matchesCapability(false, 'no')).toBe(true);
		expect(matchesCapability(null, 'any')).toBe(true);
	});
	it('covers the PRD §15 set', () => {
		expect(CAPABILITIES).toContain('structured_output');
		expect(CAPABILITIES).toContain('embeddings');
	});
});

describe('status components', () => {
	it('maps free-text incident components onto the six PRD §19 rows', () => {
		expect(componentOf('Gateway')).toBe('gateway');
		expect(componentOf('postgres')).toBe('database-services');
		expect(componentOf('something odd')).toBe('major-providers');
		expect(STATUS_COMPONENTS).toHaveLength(6);
	});
	it('derives state from open incident severity', () => {
		expect(stateFor('gateway', [])).toBe('operational');
		expect(
			stateFor('gateway', [{ component: 'gateway', severity: 'minor', status: 'investigating' }])
		).toBe('degraded');
		expect(
			stateFor('gateway', [{ component: 'gateway', severity: 'critical', status: 'identified' }])
		).toBe('major-outage');
		// A database incident must not bleed into the billing row.
		expect(
			stateFor('billing', [
				{ component: 'database-services', severity: 'major', status: 'investigating' }
			])
		).toBe('operational');
	});
});

describe('model compare selection', () => {
	it('caps at 4 and collapses duplicates', () => {
		const { slugs, truncated } = parseCompareList('a,b,a,c,d,e');
		expect(slugs).toHaveLength(MAX_COMPARE);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(truncated).toBe(true);
	});
	it('handles 1..4 models', () => {
		expect(parseCompareList('solo').slugs).toEqual(['solo']);
		expect(parseCompareList('a,b').slugs).toEqual(['a', 'b']);
		expect(addToCompare(['a'], 'b')).toEqual(['a', 'b']);
		expect(addToCompare(['a'], 'a')).toEqual(['a']);
	});
});

describe('model catalog filtering', () => {
	const models = [
		model({}),
		model({ id: 'mdl_b', slug: 'b', name: 'B', developer: 'Other', context: 2000 }),
		model({ id: 'mdl_c', slug: 'c', name: 'C', capabilities: { vision: true } })
	];
	it('filters by search, developer, context, price and capability', () => {
		expect(applyFilters(models, { ...EMPTY_FILTERS, search: 'model a' }).map((m) => m.slug)).toEqual(['a']);
		expect(applyFilters(models, { ...EMPTY_FILTERS, developer: 'Other' }).map((m) => m.slug)).toEqual(['b']);
		expect(applyFilters(models, { ...EMPTY_FILTERS, minContext: 1500 }).map((m) => m.slug)).toEqual(['b']);
		expect(
			applyFilters(models, { ...EMPTY_FILTERS, capabilities: { vision: 'yes' } }).map((m) => m.slug)
		).toEqual(['c']);
	});
	it('sorts every key and never drops a model', () => {
		const keys = [
			'name',
			'input-price',
			'output-price',
			'context',
			'popularity',
			'latency',
			'availability'
		] as const;
		for (const key of keys) {
			expect(sortModels(models, key)).toHaveLength(3);
		}
		expect(sortModels(models, 'name').map((m) => m.name)).toEqual(['B', 'C', 'Model A']);
	});
});
