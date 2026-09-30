/**
 * Routing-policy form⇄row logic (PRD §30–32) — pure, so the ranges and the
 * omitted-empty rules are tested without a server or a browser.
 *
 * Two rules this file exists to enforce:
 * - Money never touches a float: price constraints travel decimal-string →
 *   bigint micros → exact integer in jsonb (and back), never through Number
 *   arithmetic. `min_availability` is a plain 0..1 fraction and may be a number.
 * - Missing ≠ zero (spec §6/§9): a constraint the user left empty is OMITTED
 *   from the stored object, so the router knows "no claim", not "cap at 0".
 */
import { microsToInput, parseMicros } from '$lib/money';

export type StrategyId =
	| 'balanced'
	| 'lowest_cost'
	| 'lowest_latency'
	| 'highest_reliability'
	| 'provider_priority'
	| 'weighted'
	| 'round_robin'
	| 'random'
	| 'smart';

export interface StrategyMeta {
	id: StrategyId;
	label: string;
	/** Why this strategy exists (or, for `smart`, why it is not selectable yet). */
	intent: string;
	disabled: boolean;
}

/** PRD §30: `smart` is part of the vocabulary but not selectable yet. */
export const SMART_INTENT = 'Smart routing — learns from outcomes; coming soon';

export const STRATEGIES: readonly StrategyMeta[] = [
	{
		id: 'balanced',
		label: 'Balanced',
		intent: 'Score candidates on price, latency, reliability and capacity together.',
		disabled: false
	},
	{
		id: 'lowest_cost',
		label: 'Lowest cost',
		intent: 'Prefer the cheapest eligible candidate.',
		disabled: false
	},
	{
		id: 'lowest_latency',
		label: 'Lowest latency',
		intent: 'Prefer the fastest eligible candidate.',
		disabled: false
	},
	{
		id: 'highest_reliability',
		label: 'Highest reliability',
		intent: 'Prefer the most available eligible candidate.',
		disabled: false
	},
	{
		id: 'provider_priority',
		label: 'Provider priority',
		intent: 'Walk the provider preference order; earlier is preferred.',
		disabled: false
	},
	{
		id: 'weighted',
		label: 'Weighted',
		intent: 'Split load across preferred providers by the weights map.',
		disabled: false
	},
	{
		id: 'round_robin',
		label: 'Round robin',
		intent: 'Rotate evenly over eligible candidates.',
		disabled: false
	},
	{ id: 'random', label: 'Random', intent: 'Pick uniformly among eligible candidates.', disabled: false },
	{ id: 'smart', label: 'Smart', intent: SMART_INTENT, disabled: true }
] as const;

/** The selectable set — everything except `smart`. */
export const SELECTABLE_STRATEGIES: readonly StrategyMeta[] = STRATEGIES.filter((s) => !s.disabled);

export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 8;
export const TIMEOUT_MS_MIN = 1000;
export const TIMEOUT_MS_MAX = 600000;
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 100;
/** PRD §139 defaults, applied when a numeric field is left empty. */
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/** One policy row as the form's editable strings/arrays (seed for the inputs). */
export interface PolicyFormValues {
	name: string;
	strategy: string;
	enabled: boolean;
	maxAttempts: string;
	requestTimeoutMs: string;
	fallbackEnabled: boolean;
	/** Ordered preference lists — earlier is preferred. */
	providerOrder: string[];
	modelOrder: string[];
	constraints: {
		maxInputPriceMicro: string;
		maxOutputPriceMicro: string;
		maxP95LatencyMs: string;
		minAvailability: string;
		allowedProviders: string;
		blockedProviders: string;
		regionPreference: string;
	};
	weights: { price: string; latency: string; reliability: string; capacity: string };
}

/** jsonb `constraints` — all 7 keys, each present only when set (missing ≠ zero). */
export interface PolicyConstraints {
	max_input_price_micro?: number;
	max_output_price_micro?: number;
	max_p95_latency_ms?: number;
	min_availability?: number;
	allowed_providers?: string[];
	blocked_providers?: string[];
	region_preference?: string;
}

/** jsonb `weights` (balanced only) — 0..100 integers, empty cells omitted. */
export interface PolicyWeights {
	price?: number;
	latency?: number;
	reliability?: number;
	capacity?: number;
}

/** The validated row the server writes — jsonb values already cleaned. */
export interface ParsedPolicy {
	name: string;
	strategy: StrategyId;
	enabled: boolean;
	maxAttempts: number;
	requestTimeoutMs: number;
	fallbackEnabled: boolean;
	providerPreferences: { order: string[] };
	modelPreferences: { order: string[] };
	constraints: PolicyConstraints;
	weights: PolicyWeights;
}

export type ParseResult = { ok: true; values: ParsedPolicy } | { ok: false; error: string };

/**
 * The read side of a FormData. The page passes `form.get.bind(form)`; tests pass
 * a map lookup. Ordered lists travel as one newline/comma-separated field —
 * slugs never contain either separator, and FormData order cannot be lost.
 */
export type PolicyFormGetter = (key: string) => FormDataEntryValue | null;

function intField(
	raw: string,
	label: string,
	min: number,
	max: number,
	fallback: number
): number | string {
	const s = raw.trim();
	if (!s) return fallback;
	if (!/^\d+$/.test(s)) return `${label} must be a whole number`;
	const n = Number(s);
	if (n < min || n > max) return `${label} must be between ${min} and ${max}`;
	return n;
}

/** "a\nb, c" → ['a','b','c']; one slug per line or comma, order preserved. */
function slugList(raw: string): string[] {
	const out: string[] = [];
	for (const part of raw.split(/[\n,]/)) {
		const s = part.trim();
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

/**
 * Micro-unit price input: exact decimal string → micros. The conversion is
 * bigint arithmetic (money.ts) — no float ever sees the value. The range check
 * keeps the jsonb integer exact in JS (≤ 2^53 − 1).
 */
function microField(raw: string, label: string): number | string | null {
	const s = raw.trim();
	if (!s) return null;
	const micros = parseMicros(s);
	if (micros === null) return `${label} must be a decimal amount (at most 6 decimal places)`;
	if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return `${label} is too large`;
	return Number(micros);
}

/** Validate + clean the constraints block. Empty values are OMITTED (missing ≠ zero). */
export function constraintsFromForm(
	c: PolicyFormValues['constraints']
): PolicyConstraints | string {
	const out: PolicyConstraints = {};
	const input = microField(c.maxInputPriceMicro, 'Max input price');
	if (typeof input === 'string') return input;
	if (input !== null) out.max_input_price_micro = input;
	const output = microField(c.maxOutputPriceMicro, 'Max output price');
	if (typeof output === 'string') return output;
	if (output !== null) out.max_output_price_micro = output;
	const latency = c.maxP95LatencyMs.trim();
	if (latency) {
		if (!/^\d+$/.test(latency)) return 'Max p95 latency must be a whole number of milliseconds';
		out.max_p95_latency_ms = Number(latency);
	}
	const avail = c.minAvailability.trim();
	if (avail) {
		// A 0..1 fraction (e.g. 0.99). It is a ratio, not money, so Number is safe.
		if (!/^\d*\.?\d*$/.test(avail) || avail === '.') return 'Min availability must be a fraction between 0 and 1';
		const n = Number(avail);
		if (!(n >= 0 && n <= 1)) return 'Min availability must be a fraction between 0 and 1';
		out.min_availability = n;
	}
	const allowed = slugList(c.allowedProviders);
	if (allowed.length) out.allowed_providers = allowed;
	const blocked = slugList(c.blockedProviders);
	if (blocked.length) out.blocked_providers = blocked;
	const region = c.regionPreference.trim();
	if (region) out.region_preference = region;
	return out;
}

/** Validate + clean a weights block. Empty cells are omitted, not zeroed. */
export function weightsFromForm(w: PolicyFormValues['weights']): PolicyWeights | string {
	const out: PolicyWeights = {};
	for (const key of ['price', 'latency', 'reliability', 'capacity'] as const) {
		const s = w[key].trim();
		if (!s) continue;
		if (!/^\d+$/.test(s)) return `Weight ${key} must be a whole number 0–100`;
		const n = Number(s);
		if (n < WEIGHT_MIN || n > WEIGHT_MAX)
			return `Weight ${key} must be between ${WEIGHT_MIN} and ${WEIGHT_MAX}`;
		out[key] = n;
	}
	return out;
}

/**
 * Parse one submitted policy form. Returns the validated row or the first
 * validation error — the actions surface that string via `fail(400)`.
 */
export function parsePolicyForm(get: PolicyFormGetter): ParseResult {
	const name = String(get('name') ?? '').trim();
	if (!name) return { ok: false, error: 'Name is required' };
	if (name.length > 200) return { ok: false, error: 'Name must be 200 characters or fewer' };

	const strategy = String(get('strategy') ?? '').trim();
	const meta = STRATEGIES.find((s) => s.id === strategy);
	if (!meta) return { ok: false, error: 'Unknown routing strategy' };
	if (meta.disabled) return { ok: false, error: SMART_INTENT };

	const maxAttempts = intField(
		String(get('max_attempts') ?? ''),
		'Max attempts',
		MAX_ATTEMPTS_MIN,
		MAX_ATTEMPTS_MAX,
		DEFAULT_MAX_ATTEMPTS
	);
	if (typeof maxAttempts === 'string') return { ok: false, error: maxAttempts };
	const requestTimeoutMs = intField(
		String(get('request_timeout_ms') ?? ''),
		'Request timeout',
		TIMEOUT_MS_MIN,
		TIMEOUT_MS_MAX,
		DEFAULT_REQUEST_TIMEOUT_MS
	);
	if (typeof requestTimeoutMs === 'string') return { ok: false, error: requestTimeoutMs };

	const constraints = constraintsFromForm({
		maxInputPriceMicro: String(get('max_input_price_micro') ?? ''),
		maxOutputPriceMicro: String(get('max_output_price_micro') ?? ''),
		maxP95LatencyMs: String(get('max_p95_latency_ms') ?? ''),
		minAvailability: String(get('min_availability') ?? ''),
		allowedProviders: String(get('allowed_providers') ?? ''),
		blockedProviders: String(get('blocked_providers') ?? ''),
		regionPreference: String(get('region_preference') ?? '')
	});
	if (typeof constraints === 'string') return { ok: false, error: constraints };

	const weights = weightsFromForm({
		price: String(get('weight_price') ?? ''),
		latency: String(get('weight_latency') ?? ''),
		reliability: String(get('weight_reliability') ?? ''),
		capacity: String(get('weight_capacity') ?? '')
	});
	if (typeof weights === 'string') return { ok: false, error: weights };

	return {
		ok: true,
		values: {
			name,
			strategy: strategy as StrategyId,
			enabled: get('enabled') !== null,
			maxAttempts,
			requestTimeoutMs,
			fallbackEnabled: get('fallback_enabled') !== null,
			providerPreferences: { order: slugList(String(get('provider_order') ?? '')) },
			modelPreferences: { order: slugList(String(get('model_order') ?? '')) },
			constraints,
			weights
		}
	};
}

/** jsonb preferences object → the ordered list the form edits (deduped, so the
 *  keyed `#each` over it always has unique keys). */
function orderList(pref: unknown): string[] {
	const order = (pref as { order?: unknown } | null)?.order;
	if (!Array.isArray(order)) return [];
	const out: string[] = [];
	for (const s of order) {
		if (typeof s === 'string' && s.length > 0 && !out.includes(s)) out.push(s);
	}
	return out;
}

/**
 * A stored policy row → form seed values. Combined with `parsePolicyForm` this
 * round-trips every field (PRD §32): row → form → row is the identity on values,
 * empty constraints stay omitted, and price strings come back normalized but
 * numerically equal (12.50 → "12.5" → 12500000).
 */
export function policyToFormValues(row: {
	name: string;
	strategy: string;
	enabled: boolean;
	maxAttempts: number;
	requestTimeoutMs: number;
	fallbackEnabled: boolean;
	providerPreferences: unknown;
	modelPreferences: unknown;
	constraints: unknown;
	weights: unknown;
}): PolicyFormValues {
	const c = (row.constraints ?? {}) as Record<string, unknown>;
	const w = (row.weights ?? {}) as Record<string, unknown>;
	const micro = (v: unknown): string =>
		typeof v === 'number' && Number.isInteger(v) && v >= 0
			? microsToInput(BigInt(v))
			: typeof v === 'string' && /^\d+$/.test(v)
				? microsToInput(BigInt(v))
				: '';
	const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
	const list = (v: unknown): string =>
		Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').join('\n') : '';
	return {
		name: row.name,
		strategy: row.strategy,
		enabled: row.enabled,
		maxAttempts: String(row.maxAttempts),
		requestTimeoutMs: String(row.requestTimeoutMs),
		fallbackEnabled: row.fallbackEnabled,
		providerOrder: orderList(row.providerPreferences),
		modelOrder: orderList(row.modelPreferences),
		constraints: {
			maxInputPriceMicro: micro(c.max_input_price_micro),
			maxOutputPriceMicro: micro(c.max_output_price_micro),
			maxP95LatencyMs: num(c.max_p95_latency_ms),
			minAvailability: num(c.min_availability),
			allowedProviders: list(c.allowed_providers),
			blockedProviders: list(c.blocked_providers),
			regionPreference: typeof c.region_preference === 'string' ? c.region_preference : ''
		},
		weights: {
			price: num(w.price),
			latency: num(w.latency),
			reliability: num(w.reliability),
			capacity: num(w.capacity)
		}
	};
}
