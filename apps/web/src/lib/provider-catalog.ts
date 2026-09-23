/**
 * Upstream catalog parsing for the provider detail page.
 *
 * `GET <baseUrl>/models` is the one catalog surface every [OI]-compatible
 * upstream shares, but the payload is not standardised:
 *
 *   OpenRouter  `pricing: { prompt: "0.0000015", completion: "0.000006" }`  (per TOKEN, strings)
 *   InferHub    `pricing: { official_in: 0.15, official_out: 0.6 }`         (per 1M TOKENS)
 *   others      no pricing at all, or a bare `data: [{id}]`
 *
 * This module normalises those into one row shape and classifies the tier, so the
 * page never has to guess and the "free only / paid only" filters mean something.
 *
 * Price units: a per-1M field is used as-is; a per-token field is multiplied by
 * 1e6. Prices are carried as USD-per-1M numbers for display and converted to
 * micro-units only when a model is enabled.
 */

export type ModelTier = 'free' | 'paid' | 'unknown';

export interface UpstreamModel {
	slug: string;
	name: string;
	context: number | null;
	/** USD per 1M tokens, or null when the upstream did not report a price. */
	inputUsd: number | null;
	outputUsd: number | null;
	tier: ModelTier;
}

/** A price pair read straight from the upstream, in USD per 1M tokens. */
interface PricePair {
	keysIn: string[];
	keysOut: string[];
	perMtok: boolean;
}

const PRICE_PAIRS: PricePair[] = [
	{ keysIn: ['official_in'], keysOut: ['official_out'], perMtok: true },
	{ keysIn: ['input_price', 'input'], keysOut: ['output_price', 'output'], perMtok: true },
	// Last: OpenRouter's per-token shape. Only reached when no per-1M pair exists.
	{ keysIn: ['prompt'], keysOut: ['completion'], perMtok: false }
];

const CONTEXT_KEYS = [
	'context_length',
	'context_window',
	'input_token_limit',
	'max_context_length',
	'context'
];

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const n = asNumber(source[key]);
		if (n !== null) return n;
	}
	return null;
}

/** Pick the first price pair the entry actually reports, normalised to per-1M. */
function prices(entry: Record<string, unknown>): {
	inputUsd: number | null;
	outputUsd: number | null;
} {
	const pricing = asRecord(entry.pricing) ?? asRecord(entry.price) ?? entry;
	for (const pair of PRICE_PAIRS) {
		const rawIn = firstNumber(pricing, pair.keysIn);
		const rawOut = firstNumber(pricing, pair.keysOut);
		if (rawIn === null && rawOut === null) continue;
		const scale = pair.perMtok ? 1 : 1_000_000;
		// Round the scaled value: 0.0000015 * 1e6 is 1.5000000000000002 in binary
		// floating point, and an unrounded price shows up in the UI and in the
		// micro-unit conversion.
		const scaled = (v: number | null) => (v === null ? null : Number((v * scale).toFixed(6)));
		return { inputUsd: scaled(rawIn), outputUsd: scaled(rawOut) };
	}
	return { inputUsd: null, outputUsd: null };
}

/**
 * Free means zero cost, not "cheap". A slug that says `:free` is free regardless
 * of pricing, because several aggregators publish the free variant under a
 * suffixed id while quoting the paid variant's price.
 */
export function classifyTier(
	slug: string,
	inputUsd: number | null,
	outputUsd: number | null
): ModelTier {
	if (slug.endsWith(':free')) return 'free';
	if (inputUsd === null && outputUsd === null) return 'unknown';
	// A missing side is treated as zero: an upstream that quotes only one side is
	// still telling us the model is not billed on the other.
	return (inputUsd ?? 0) === 0 && (outputUsd ?? 0) === 0 ? 'free' : 'paid';
}

/** Normalise a `GET /models` payload. Tolerates `{data:[…]}` and a bare array. */
export function parseUpstreamModels(payload: unknown): UpstreamModel[] {
	const root = asRecord(payload);
	const raw = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : [];

	const out: UpstreamModel[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const entry = asRecord(item);
		if (!entry) continue;
		const slug = String(entry.id ?? entry.model ?? entry.slug ?? '').trim();
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);

		const { inputUsd, outputUsd } = prices(entry);
		const context = firstNumber(entry, CONTEXT_KEYS);
		out.push({
			slug,
			// `label` is what TokenHarbor ships instead of `name`.
			name: String(entry.name ?? entry.display_name ?? entry.label ?? slug),
			context: context === null ? null : Math.round(context),
			inputUsd,
			outputUsd,
			tier: classifyTier(slug, inputUsd, outputUsd)
		});
	}
	return out;
}

export function filterByTier<T extends UpstreamModel>(models: T[], tier: 'all' | ModelTier): T[] {
	return tier === 'all' ? models : models.filter((m) => m.tier === tier);
}

export function tierCounts(models: UpstreamModel[]): Record<ModelTier, number> {
	const counts: Record<ModelTier, number> = { free: 0, paid: 0, unknown: 0 };
	for (const m of models) counts[m.tier] += 1;
	return counts;
}

/** Where a fetched slug stands relative to the seeded catalog. */
export type SeedState = 'active' | 'hidden' | 'new';

export function seedState(seededStatus: string | undefined): SeedState {
	if (seededStatus === undefined) return 'new';
	return seededStatus === 'active' ? 'active' : 'hidden';
}

/** `:free`-suffixed slugs are the free tier of a paid model — keep the suffix. */
export function slugSuffixNote(slug: string): string | null {
	return slug.endsWith(':free') ? 'free tier of a paid model' : null;
}

/**
 * The id an upstream reports is not always the slug we route with. Google's
 * [OI]-compat layer lists `models/gemini-3.6-flash` while the router's slug for
 * the same model is `gemini-3.6-flash`, so a raw comparison marks every Google
 * model "not seeded" and enabling one would insert a duplicate row.
 *
 * Used for MATCHING only. A stored slug is never rewritten: the data plane
 * forwards the client's `model` field upstream verbatim, so the slug we keep is
 * the one that is known to work.
 */
export function matchKey(slug: string): string {
	return slug.replace(/^models\//, '');
}
