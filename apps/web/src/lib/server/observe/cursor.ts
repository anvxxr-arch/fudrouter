/**
 * Keyset cursor for request-log pagination (PRD §119: cursor, not deep OFFSET).
 *
 * The key is (created_at, id) in descending order — `created_at` alone is not
 * unique (a burst shares a timestamp) so the id breaks ties and makes the walk
 * total-ordered. The cursor is base64url of `<ISO>|<id>`: opaque on the wire,
 * decodable in a support ticket, and self-describing when truncated (a bad
 * cursor decodes to null and the page falls back to the first page rather than
 * silently skipping rows).
 */
export type Cursor = { createdAt: Date; id: string };

export function encodeCursor(c: Cursor): string {
	return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
	if (!raw) return null;
	let text: string;
	try {
		text = Buffer.from(raw, 'base64url').toString('utf8');
	} catch {
		return null;
	}
	const bar = text.indexOf('|');
	if (bar < 0) return null;
	const id = text.slice(bar + 1);
	const when = new Date(text.slice(0, bar));
	if (id.length === 0 || Number.isNaN(when.getTime())) return null;
	return { createdAt: when, id };
}
