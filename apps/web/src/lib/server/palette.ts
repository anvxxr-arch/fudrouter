/**
 * Command-palette search queries (PRD §106).
 *
 * Shared by the `/api/palette/*` endpoints so every resource is searched the
 * same way: `ilike` with the wildcards in the user's query neutralized (a `%`
 * typed into a search box must not become a match-everything pattern) and the
 * limit clamped to the 1..20 window the palette renders.
 */
/** `%` and `_` are LIKE wildcards; backslash must go first. */
export function escapeLike(q: string): string {
	return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function likePattern(q: string, kind: 'contains' | 'prefix' = 'contains'): string {
	const escaped = escapeLike(q);
	return kind === 'prefix' ? `${escaped}%` : `%${escaped}%`;
}

export interface PaletteParams {
	q: string;
	limit: number;
}

/** The one place that reads the query string for all palette endpoints. */
export function paletteParams(url: URL): PaletteParams {
	const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
	const raw = url.searchParams.get('limit');
	const parsed = raw === null || raw === '' ? Number.NaN : Number(raw);
	// Garbage limits fall back to the palette's own page size (8), not to 1,
	// so a malformed request still renders a useful first screen.
	const limit = Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.floor(parsed))) : 8;
	return { q, limit };
}
