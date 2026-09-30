/**
 * Model compare (PRD §16) — pure selection logic.
 *
 * Up to 4 models side by side, NO subjective ranking: the compare page shows
 * facts (developer, context, prices, capabilities, provider count, observed
 * latency) and never scores or orders them "best".
 */
export const MAX_COMPARE = 4;

/**
 * Resolve the `?models=a,b,c` query to at most MAX_COMPARE distinct, non-empty
 * slugs, preserving order. Duplicates collapse; overflow is truncated (the page
 * reports the truncation rather than erroring).
 */
export function parseCompareList(raw: string | null | undefined): {
	slugs: string[];
	truncated: boolean;
} {
	const all = (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	const slugs: string[] = [];
	for (const s of all) {
		if (seen.has(s)) continue;
		seen.add(s);
		slugs.push(s);
	}
	return { slugs: slugs.slice(0, MAX_COMPARE), truncated: slugs.length > MAX_COMPARE };
}

/** Add a slug to the current list (query-param round trip), respecting the cap. */
export function addToCompare(current: string[], slug: string): string[] {
	if (current.includes(slug)) return current.slice(0, MAX_COMPARE);
	return [...current, slug].slice(0, MAX_COMPARE);
}
