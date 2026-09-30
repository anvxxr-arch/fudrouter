/**
 * Command-palette query and ranking helpers (PRD §106).
 *
 * Pure — no Svelte, no fetch, no DOM — so ranking behaviour is unit-testable
 * and shared between the palette component and any future entry point. The
 * component owns interaction; this file owns "what matches, in what order".
 */

/** One result row as served by /api/palette/* endpoints. */
export interface PaletteItem {
	id: string;
	type: 'project' | 'key' | 'model' | 'provider' | 'request' | 'workspace';
	title: string;
	subtitle: string;
	href: string;
}

/** A static shortcut rendered above the fetched groups. */
export interface PaletteAction {
	id: string;
	title: string;
	hint?: string;
	run: () => void;
}

export interface PaletteGroup {
	title: string;
	items: PaletteItem[];
}

/** Group headings in render order; unknown item types sort last by title. */
export const GROUP_TITLES: Record<PaletteItem['type'], string> = {
	project: 'Projects',
	key: 'API keys',
	model: 'Models',
	provider: 'Providers',
	request: 'Requests',
	workspace: 'Workspaces'
};

const GROUP_ORDER: PaletteItem['type'][] = [
	'project',
	'key',
	'model',
	'provider',
	'request',
	'workspace'
];

/**
 * Normalize a query: trim ends, collapse internal whitespace. "  a   b " and
 * "a b" must rank identically, otherwise the same keystrokes feel flaky.
 */
export function normalizeQuery(q: string): string {
	return q.trim().replace(/\s+/g, ' ');
}

/** Lowercased match form of the query; the palette matches case-insensitively. */
export function matchText(q: string): string {
	return normalizeQuery(q).toLowerCase();
}

/**
 * Rank score for one title candidate against a query. Higher is better.
 * 3 = exact string, 2 = prefix, 1 = a word boundary starts a match,
 * 0 = substring anywhere, -1 = no match. The three-tier order (exact prefix >
 * word-start > substring) is what makes "proj" hit "Projects" before
 * "reproject" even when alphabet would disagree.
 */
export function rankScore(candidate: string, query: string): number {
	const c = candidate.toLowerCase();
	const q = matchText(query);
	if (!q) return 0;
	if (c === q) return 3;
	if (c.startsWith(q)) return 2;
	// Word-start: the query begins at a boundary (space, dash, underscore, dot).
	const idx = c.indexOf(q);
	if (idx > 0 && /[\s\-_./]/.test(c[idx - 1])) return 1;
	if (idx >= 0) return 0;
	return -1;
}

/** Best score over a row's searchable fields (title, subtitle, id). */
export function itemScore(item: PaletteItem, query: string): number {
	const q = matchText(query);
	if (!q) return 0;
	return Math.max(rankScore(item.title, q), rankScore(item.subtitle, q), rankScore(item.id, q));
}

/**
 * Rank items for a query: match score descending, then alphabetical by title
 * (case-insensitive), then by id so equal titles have a stable order. Empty
 * query returns everything in alphabetical order — the palette still shows a
 * useful first page instead of a blank panel.
 */
export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
	const scored = items
		.map((item) => ({ item, score: itemScore(item, query) }))
		.filter((s) => s.score >= 0);
	scored.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		const t = a.item.title.toLowerCase().localeCompare(b.item.title.toLowerCase());
		if (t !== 0) return t;
		return a.item.id.localeCompare(b.item.id);
	});
	return scored.map((s) => s.item);
}

/** Case-insensitive "does any label field contain q" for static actions. */
export function filterActions<T extends { title: string; hint?: string }>(
	actions: readonly T[],
	query: string
): T[] {
	const q = matchText(query);
	if (!q) return [...actions];
	return actions.filter((a) => {
		const hay = `${a.title} ${a.hint ?? ''}`.toLowerCase();
		const score = Math.max(rankScore(a.title, q), rankScore(a.hint ?? '', q));
		return score >= 0 || hay.includes(q);
	});
}

/**
 * Assemble ranked items into visible groups in canonical order, omitting empty
 * groups. Items inside a group keep the ranking order handed in.
 */
export function assembleGroups(items: PaletteItem[]): PaletteGroup[] {
	const byType = new Map<PaletteItem['type'], PaletteItem[]>();
	for (const item of items) {
		const bucket = byType.get(item.type);
		if (bucket) bucket.push(item);
		else byType.set(item.type, [item]);
	}
	return GROUP_ORDER.flatMap((type) => {
		const group = byType.get(type);
		return group && group.length > 0 ? [{ title: GROUP_TITLES[type], items: group }] : [];
	});
}

/** Clamp a requested limit to the API's supported window (1..20). */
export function clampLimit(limit: number, min = 1, max = 20): number {
	if (!Number.isFinite(limit)) return max;
	return Math.min(max, Math.max(min, Math.floor(limit)));
}
