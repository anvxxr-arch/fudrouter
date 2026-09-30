import { describe, expect, it } from 'vitest';
import { titleFor } from './titles';

describe('titleFor', () => {
	it('names each top-level surface', () => {
		expect(titleFor('/')).toBe('Home — fudrouter');
		expect(titleFor('/pricing')).toBe('Pricing — fudrouter');
		expect(titleFor('/dashboard')).toBe('Dashboard — fudrouter');
		expect(titleFor('/admin')).toBe('Admin overview — fudrouter');
	});

	it('resolves the longest matching prefix for nested paths', () => {
		expect(titleFor('/admin/providers')).toBe('Providers — fudrouter');
		expect(titleFor('/legal/terms')).toBe('Terms of Service — fudrouter');
	});

	it('resolves nested and parameterized routes by their template', () => {
		// A parameterised final segment resolves to the detail title...
		expect(titleFor('/models/gpt-5.6')).toBe('Model Detail — fudrouter');
		// ...and a middle param segment resolves through to the leaf template.
		expect(titleFor('/dashboard/projects/prj_1/requests')).toBe('Request Logs — fudrouter');
		expect(titleFor('/dashboard/projects/prj_1/requests/req_9')).toBe('Request Detail — fudrouter');
		// ...while a literal sibling template wins over it for the same shape.
		expect(titleFor('/models/compare')).toBe('Compare Models — fudrouter');
	});
	it('resolves a catch-all template across one or more trailing segments', () => {
		expect(titleFor('/docs/api/authentication')).toBe('Documentation — fudrouter');
		expect(titleFor('/docs/deep/nested/page')).toBe('Documentation — fudrouter');
	});
	it('falls back to the site name for an unknown path', () => {
		expect(titleFor('/totally/unknown')).toBe('fudrouter');
	});

	it('never returns an empty title', () => {
		for (const p of ['/', '/nope', '/admin/whatever']) {
			expect(titleFor(p).length).toBeGreaterThan(0);
		}
	});
});
