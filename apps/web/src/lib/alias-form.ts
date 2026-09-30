/**
 * Pure alias form ⇄ row logic (PRD §35).
 *
 * The alias editor's payload is an ordered, duplicate-free list of model ids plus
 * a slug-safe name — exactly the rules the API enforces. Keeping parsing and
 * target-row construction here (no `$app` imports) means the rules are testable
 * without a request, and the page never re-implements them with slightly
 * different trimming.
 */
export interface AliasFormValue {
	name: string;
	description: string;
	enabled: boolean;
	/** Ordered model ids: index 0 is the primary model. */
	targets: string[];
}

export interface AliasTargetRow {
	aliasId: string;
	modelId: string;
	position: number;
}

/** PRD §125: a target in one of these states must be flagged wherever it is shown. */
export const WARNING_TARGET_STATUSES: Record<string, true> = {
	deprecated: true,
	sunset: true
};

/** Lowercase letters, digits and dashes, 2..64 chars — safe in slugs and URLs. */
export const ALIAS_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ALIAS_NAME_HINT = '2–64 characters: lowercase letters, digits and dashes.';

export type ParsedAliasForm =
	| { ok: true; value: AliasFormValue }
	| { ok: false; error: string };

/**
 * Parse the alias form into a validated value.
 *
 * `get` is `FormData.get`; the ordered target list arrives as one JSON array in
 * the `targets` field (the page owns the ordering UI and posts the final order),
 * so this stays free of `$app` and of any multi-value plumbing.
 */
export function parseAliasForm(get: (k: string) => FormDataEntryValue | null): ParsedAliasForm {
	const name = String(get('name') ?? '')
		.trim()
		.toLowerCase();
	if (!ALIAS_NAME_PATTERN.test(name)) {
		return { ok: false, error: `Invalid name: use ${ALIAS_NAME_HINT}` };
	}
	const raw = get('description');
	const description = raw == null ? '' : String(raw).trim();
	const enabled = get('enabled') != null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(String(get('targets') ?? '[]'));
	} catch {
		return { ok: false, error: 'Targets must be a JSON array of model ids.' };
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, error: 'Targets must be a JSON array of model ids.' };
	}
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const entry of parsed) {
		if (typeof entry !== 'string' || entry.trim() === '') {
			return { ok: false, error: 'Targets must be model ids (non-empty strings).' };
		}
		const modelId = entry.trim();
		if (seen.has(modelId)) {
			return { ok: false, error: 'Each model may appear in the fallback list only once.' };
		}
		seen.add(modelId);
		targets.push(modelId);
	}
	if (targets.length === 0) {
		return { ok: false, error: 'Pick at least one model as the primary target.' };
	}
	return { ok: true, value: { name, description, enabled, targets } };
}

/**
 * Target rows for a rewrite: positions are 1..N in the given order — the same
 * order the router walks when the primary model is unavailable.
 */
export function targetRows(aliasId: string, modelIds: string[]): AliasTargetRow[] {
	return modelIds.map((modelId, i) => ({ aliasId, modelId, position: i + 1 }));
}
