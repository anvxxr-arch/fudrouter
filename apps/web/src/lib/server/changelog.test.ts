import { describe, expect, it } from 'vitest';
import { changelog, changelogEntry } from './changelog';
describe('the changelog folder', () => {
	it('has the platform build as an entry', () => {
		const entries = changelog();
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.some((e) => e.slug === '2026-09-30-platform-build')).toBe(true);
	});
	it('resolves an entry by slug', () => {
		expect(changelogEntry('2026-09-30-platform-build')?.date).toBe('2026-09-30');
		expect(changelogEntry('nope')).toBeNull();
	});
});
