/**
 * Model capability vocabulary (PRD §15) — one list, shared by the model detail
 * page, the model catalog filters and the compare page, so the three cannot
 * drift into three spellings of "structured output".
 */
export const CAPABILITIES = [
	'text',
	'vision',
	'audio',
	'tools',
	'reasoning',
	'structured_output',
	'streaming',
	'embeddings'
] as const;
export type CapabilityKey = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
	text: 'Text',
	vision: 'Vision',
	audio: 'Audio',
	tools: 'Tools',
	reasoning: 'Reasoning',
	structured_output: 'Structured output',
	streaming: 'Streaming',
	embeddings: 'Embeddings'
};

/**
 * Effective capability = canonical value, overridden where the provider_model
 * says otherwise. A MISSING key is not a claim (spec §5): it renders as unknown,
 * never as "no" — an unenriched catalog must not black-hole a model.
 */
export function effectiveCapability(
	canonical: Record<string, boolean>,
	overrides: Record<string, boolean>,
	key: CapabilityKey
): boolean | null {
	if (typeof overrides[key] === 'boolean') return overrides[key];
	if (typeof canonical[key] === 'boolean') return canonical[key];
	return null;
}

/** Capability filter tri-state: require-true, require-false, or don't care. */
export function matchesCapability(value: boolean | null, filter: 'any' | 'yes' | 'no'): boolean {
	if (filter === 'any') return true;
	if (value === null) return false;
	return filter === 'yes' ? value : !value;
}
