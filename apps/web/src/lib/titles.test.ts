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

	it('falls back to the site name for an unknown path', () => {
		expect(titleFor('/totally/unknown')).toBe('fudrouter');
	});

	it('never returns an empty title', () => {
		for (const p of ['/', '/nope', '/admin/whatever']) {
			expect(titleFor(p).length).toBeGreaterThan(0);
		}
	});
});
