import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDES, guideFor, type GuideId } from './guides';

const routes = new URL('../routes/', import.meta.url);

function pageFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...pageFiles(path));
		else if (name === '+page.svelte') out.push(path);
	}
	return out;
}

describe('page guides', () => {
	it('covers public, member, and admin', () => {
		const audiences = new Set(Object.values(GUIDES).map((g) => g.audience));
		expect(audiences).toEqual(new Set(['public', 'member', 'admin']));
	});

	it.each(Object.keys(GUIDES) as GuideId[])('%s has a title and some facts or prose', (id) => {
		const guide = guideFor(id);
		expect(guide.sections.length).toBeGreaterThan(0);
		const titles = guide.sections.map((s) => s.title);
		expect(new Set(titles).size).toBe(titles.length);
		for (const section of guide.sections) {
			expect(section.title.length).toBeGreaterThan(0);
			const hasBody = (section.paragraphs?.length ?? 0) > 0 || (section.facts?.length ?? 0) > 0;
			expect(hasBody, `${id} / ${section.title} is empty`).toBe(true);
			for (const fact of section.facts ?? []) {
				expect(fact.term.length).toBeGreaterThan(0);
				expect(fact.detail.length).toBeGreaterThan(0);
			}
			const terms = (section.facts ?? []).map((f) => f.term);
			expect(new Set(terms).size, `duplicate fact term in ${id}`).toBe(terms.length);
		}
	});

	it('is rendered by every page', () => {
		const missing = pageFiles(routes.pathname).filter((path) => {
			const src = readFileSync(path, 'utf8');
			return !src.includes('<Guide ');
		});
		expect(missing, 'pages without <Guide>').toEqual([]);
	});
});
