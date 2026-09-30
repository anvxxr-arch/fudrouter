/**
 * Changelog — source of truth is `docs/changelog/*.md`, one file per entry.
 *
 * WHY A FOLDER AND NOT system_event: entries are written before they ship (this
 * build is entry #1 and its file existed before the code did), reviewed like
 * code, and never mutated afterwards. `system_event` is a runtime log of things
 * that HAPPENED (spec §11); a changelog entry is a published statement. The
 * folder is also the git-visible record, so "what changed in this release" is
 * answerable from the repo alone.
 *
 * File convention (enforced by server/changelog.test.ts):
 *   - filename `YYYY-MM-DD-<slug>.md` — date first, so lexical order is newest-first
 *   - first line `# Title`
 *   - body: markdown in the subset `lib/markdown.ts` renders
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '$lib/markdown';

export interface ChangelogEntry {
	/** The filename slug, used by /changelog/[slug]. */
	slug: string;
	title: string;
	date: string;
	html: string;
}

/** Repo-root `docs/changelog`, resolved from apps/web's cwd. */
const DIR = join(process.cwd(), '..', '..', 'docs', 'changelog');

/** Newest-first. Reads the folder fresh — entries ship with code, not with cache. */
export function changelog(): ChangelogEntry[] {
	const files = readdirSync(DIR)
		.filter((f) => f.endsWith('.md'))
		.sort()
		.reverse();
	return files.map((file) => {
		const raw = readFileSync(join(DIR, file), 'utf8');
		const match = /^#\s+(.+)$/m.exec(raw);
		return {
			slug: file.replace(/\.md$/, ''),
			title: match ? match[1].trim() : file,
			date: file.slice(0, 10),
			html: renderMarkdown(raw.replace(/^#\s+.+\s*$/, ''))
		};
	});
}

export function changelogEntry(slug: string): ChangelogEntry | null {
	return changelog().find((e) => e.slug === slug) ?? null;
}
