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

/**
 * "(public)/pricing/+page.svelte" -> "pricing"; "" for the index page.
 * A SvelteKit route group — "(public)", "(admin)" — is part of the directory
 * name and never part of the URL, so it is dropped along with the filename.
 */
function routeId(path: string): string {
	const base = path.slice(routes.pathname.length).replace(/\/\+page\.svelte$/, '');
	return base.replace(/^\([^/]+\)\//, '');
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

	it('is rendered by every page that leads with a form or a table', () => {
		// Public marketing pages deliberately carry no guide: a visitor who
		// opened /pricing wants prices, not a glossary explaining how to read
		// them. Reference material lives in the `docs` guide.
		const PUBLIC_WITHOUT = new Set(['pricing', 'models', 'status', 'login', 'signup']);
		const missing = pageFiles(routes.pathname)
			.filter((path) => !PUBLIC_WITHOUT.has(routeId(path)))
			.filter((path) => !readFileSync(path, 'utf8').includes('<Guide '));
		expect(missing, 'pages without <Guide>').toEqual([]);
	});

	describe('public pages stay quiet', () => {
		// The constraint that keeps a public page a landing page rather than a
		// manual. It is enforced rather than trusted: the guides were written
		// one page at a time and grew into 270 words on the landing alone.
		const WORDS = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

		const paragraphs = (id: GuideId) =>
			guideFor(id).sections.flatMap((s) => (s.paragraphs ?? []).map((p) => [s.title, p] as const));
		const wordsOf = (id: GuideId) =>
			guideFor(id).sections.reduce(
				(n, s) =>
					n +
					WORDS(s.title) +
					WORDS(s.lede ?? '') +
					(s.paragraphs ?? []).reduce((m, p) => m + WORDS(p), 0) +
					(s.facts ?? []).reduce((m, f) => m + WORDS(f.term) + WORDS(f.detail), 0),
				0
			);

		it('keeps the landing to one short section', () => {
			const sections = guideFor('home').sections;
			expect(sections, 'the landing carries more than one block of prose').toHaveLength(1);
			const words = wordsOf('home');
			expect(
				words,
				`the landing guide is ${words} words — it should orient, not explain`
			).toBeLessThan(60);
		});

		it('has no public paragraph longer than a sentence or two', () => {
			// A 46-word paragraph on a public page reads as an internal note. The
			// one that existed ("treat the coding column as a preview…") was
			// written for the people who maintain the catalog.
			const offenders = paragraphs('home')
				.concat(paragraphs('docs'))
				.map(([title, p]) => [title, p, WORDS(p)] as const)
				.filter(([, , w]) => w >= 40);
			expect(offenders, 'a paragraph this long belongs in an internal runbook').toEqual([]);
		});

		it('keeps every guide reachable — nothing is defined and never rendered', () => {
			const rendered = pageFiles(routes.pathname).flatMap((path) =>
				[...readFileSync(path, 'utf8').matchAll(/<Guide id="([^"]+)"/g)].map((m) => m[1])
			);
			const orphans = (Object.keys(GUIDES) as GuideId[]).filter((id) => !rendered.includes(id));
			expect(orphans, `defined but never rendered: ${orphans.join(', ')}`).toEqual([]);
		});
	});
});
