/**
 * Admin vocabulary — status enums and form parsers shared by every admin slice
 * (PRD §52 provider, §55 credential, §57 model, §125 model status).
 *
 * One copy of each vocabulary so the provider form, the model form and the
 * filter dropdowns can never drift apart. Reads accept whatever is stored;
 * writes validate against these lists (the status CHECK constraints accept both
 * vocabularies as of migration 0009).
 *
 * NOTE: this file deliberately contains NO backslash escapes — none in regex
 * classes, none in string literals — so transport-layer escape mangling cannot
 * corrupt it. Character-code loops stand in for control-character classes.
 */
export const PROVIDER_STATUSES = [
	'operational',
	'degraded',
	'disabled',
	'maintenance',
	'outage'
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_TIERS = ['commercial', 'dev'] as const;
export type ProviderTier = (typeof PROVIDER_TIERS)[number];

export const MODEL_STATUSES = ['active', 'deprecated', 'sunset', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export const CREDENTIAL_STATUSES = [
	'healthy',
	'rate_limited',
	'cooldown',
	'auth_failed',
	'invalid',
	'disabled',
	'unknown'
] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CONNECTION_HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export type ConnectionHealthStatus = (typeof CONNECTION_HEALTH_STATUSES)[number];

export const CONNECTION_AUTH_TYPES = ['bearer', 'oauth', 'header', 'query'] as const;
export type ConnectionAuthType = (typeof CONNECTION_AUTH_TYPES)[number];

export const PROVIDER_MODEL_STATUSES = [
	'available',
	'degraded',
	'unavailable',
	'deprecated',
	'disabled'
] as const;
export type ProviderModelStatus = (typeof PROVIDER_MODEL_STATUSES)[number];

export const CIRCUIT_TARGETS = ['provider', 'connection', 'model'] as const;
export type CircuitTarget = (typeof CIRCUIT_TARGETS)[number];

/** Narrow a form value to a known enum member, or null. */
export function parseEnum<T extends string>(
	allowed: readonly T[],
	raw: FormDataEntryValue | null | undefined
): T | null {
	const v = String(raw ?? '').trim();
	return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * Trimmed non-empty text, capped at `max` chars (0-length -> null). Control
 * characters are stripped (they would corrupt JSON payloads and log lines);
 * tab (9), newline (10) and carriage return (13) are kept because multi-line
 * copy is legitimate input. Character-code test, not a regex class — see the
 * file note above.
 */
export function cleanField(
	raw: FormDataEntryValue | null | undefined,
	max = 200
): string | null {
	const v = String(raw ?? '').trim();
	if (!v || v.length > max) return null;
	let out = '';
	for (const ch of v) {
		const code = ch.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += ch;
	}
	return out;
}

/** Slug: lookup token, no whitespace (it is a key, not copy). */
export function parseSlugField(raw: FormDataEntryValue | null | undefined): string | null {
	const v = String(raw ?? '').trim();
	if (!v || v.length > 120) return null;
	return /^[A-Za-z0-9._:/-]+$/.test(v) ? v : null;
}

/** Bounded non-negative integer form field, or null. */
export function parseIntField(
	raw: FormDataEntryValue | null | undefined,
	opts: { min: number; max: number }
): number | null {
	const v = String(raw ?? '').trim();
	if (!v || !/^[0-9]+$/.test(v)) return null;
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) return null;
	return n;
}

/** `on`/`true`/`1` checkbox semantics -> boolean, default false. */
export function parseBoolField(raw: FormDataEntryValue | null | undefined): boolean {
	const v = String(raw ?? '').trim().toLowerCase();
	return v === 'on' || v === 'true' || v === '1';
}

/**
 * A jsonb flags object from a textarea: `{"vision": true, "tools": false}`.
 * Only boolean values are claims (spec §5: a missing key is not a claim), so a
 * non-boolean entry is rejected wholesale rather than coerced.
 */
export function parseFlagsField(
	raw: FormDataEntryValue | null | undefined
): Record<string, boolean> | null {
	const v = String(raw ?? '').trim();
	if (!v) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(v);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const out: Record<string, boolean> = {};
	for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof val !== 'boolean') return null;
		out[k] = val;
	}
	return out;
}

/** Arbitrary jsonb config object (`connection.config`, rule config, ...). */
export function parseJsonField(
	raw: FormDataEntryValue | null | undefined
): Record<string, unknown> | null {
	const v = String(raw ?? '').trim();
	if (!v) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(v);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}
