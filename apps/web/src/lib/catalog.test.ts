import { describe, expect, it } from 'vitest';
import {
	API_SURFACE_ORDER,
	API_SURFACES,
	buildCatalog,
	modelsOn,
	tierTone,
	type ModelRow
} from './catalog';

const rows: ModelRow[] = [
	{ slug: 'grok-4.7', name: 'Grok 4.7', context: 500000 },
	{ slug: 'grok-4.6', name: 'Grok 4.6', context: 500000 },
	{ slug: 'unlisted-model', name: 'Unlisted', context: null }
];

describe('catalog surfaces', () => {
	it('declares metadata for every surface it renders', () => {
		for (const surface of API_SURFACE_ORDER) {
			const meta = API_SURFACES[surface];
			expect(meta, `no metadata for surface ${surface}`).toBeTruthy();
			expect(meta.path.startsWith('/')).toBe(true);
			expect(meta.label.length).toBeGreaterThan(0);
			expect(meta.lede.length).toBeGreaterThan(0);
		}
	});

	it('gives the two surfaces distinct path prefixes', () => {
		const paths = API_SURFACE_ORDER.map((s) => API_SURFACES[s].path);
		expect(new Set(paths).size).toBe(paths.length);
	});
});

describe('buildCatalog', () => {
	const catalog = buildCatalog(rows);

	it('keeps every row, in the order given', () => {
		expect(catalog.map((m) => m.slug)).toEqual(['grok-4.7', 'grok-4.6', 'unlisted-model']);
	});

	it('attaches the placeholder tier for a listed slug', () => {
		const m = catalog.find((c) => c.slug === 'grok-4.6')!;
		expect(m.surfaces).toEqual([
			{ surface: 'payg', tier: 'premium' },
			{ surface: 'coding', tier: 'free' }
		]);
	});

	it('falls back to the default assignment for an unlisted slug', () => {
		const m = catalog.find((c) => c.slug === 'unlisted-model')!;
		expect(m.surfaces).toEqual([{ surface: 'payg', tier: 'premium' }]);
	});

	it('never emits a surface with no tier', () => {
		for (const m of catalog) {
			expect(m.surfaces.length).toBeGreaterThan(0);
			for (const s of m.surfaces) expect(['free', 'premium']).toContain(s.tier);
		}
	});
});

describe('modelsOn', () => {
	const catalog = buildCatalog(rows);

	it('returns only models served on that surface, sorted by slug', () => {
		expect(modelsOn(catalog, 'coding')).toEqual([
			{ model: expect.objectContaining({ slug: 'grok-4.6' }), tier: 'free' },
			{ model: expect.objectContaining({ slug: 'grok-4.7' }), tier: 'premium' }
		]);
	});

	it('reports the tier for that surface, not a global one', () => {
		const coding = modelsOn(catalog, 'coding').find((e) => e.model.slug === 'grok-4.6')!;
		const payg = modelsOn(catalog, 'payg').find((e) => e.model.slug === 'grok-4.6')!;
		expect(coding.tier).toBe('free');
		expect(payg.tier).toBe('premium');
	});

	it('does not duplicate a model that appears on both surfaces', () => {
		for (const surface of API_SURFACE_ORDER) {
			const slugs = modelsOn(catalog, surface).map((e) => e.model.slug);
			expect(new Set(slugs).size).toBe(slugs.length);
		}
	});

	it('returns an empty list for a surface no model declares', () => {
		const onlyPayg = buildCatalog([{ slug: 'unlisted-model', name: 'X', context: null }]);
		expect(modelsOn(onlyPayg, 'coding')).toEqual([]);
	});
});

describe('tierTone', () => {
	it('maps each tier to a distinct badge tone', () => {
		expect(tierTone('free')).toBe('success');
		expect(tierTone('premium')).toBe('info');
	});
});
