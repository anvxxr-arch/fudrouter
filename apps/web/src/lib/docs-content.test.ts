import { describe, expect, it } from 'vitest';
import { DOC_BY_PATH, DOC_CATEGORIES, DOC_FLAT } from './docs-content';
// Structural invariants of the docs tree (PRD §131): the URL map is what the
// sidebar, index and prev/next all walk, so a duplicate or missing path would
// break navigation silently. Content wording is NOT asserted here — that is
// the rendered page's job.
describe('docs tree', () => {
	it('covers the twelve PRD §131 categories in order', () => {
		expect(DOC_CATEGORIES.map((c) => c.title)).toEqual([
			'Getting Started',
			'API',
			'Models',
			'Routing',
			'Projects',
			'API Keys',
			'Usage',
			'Observability',
			'Billing',
			'SDKs',
			'Compatibility',
			'Reference'
		]);
	});
	it('gives every page a unique category/page path', () => {
		expect(DOC_BY_PATH['getting-started/quickstart']).toBeDefined();
		expect(DOC_FLAT.length).toBe(Object.keys(DOC_BY_PATH).length);
	});
	it('flattens in category order so prev/next walk the same tree the index lists', () => {
		expect(DOC_FLAT[0].path).toBe('getting-started/quickstart');
		expect(DOC_FLAT[1].path).toBe('api/authentication');
		expect(DOC_FLAT.at(-1)?.path).toBe('reference/reference');
	});
});
