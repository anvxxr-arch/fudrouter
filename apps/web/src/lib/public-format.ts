/**
 * Display formatting for the public catalog pages.
 *
 * Prices arrive as exact decimal STRINGS (numeric(18,6) micro-units per 1M
 * tokens, e.g. "2000000.000000" = $2.00 per 1M). Money never touches a float:
 * the decimal is split into whole/fraction parts and assembled as a bigint in
 * micro-units, which `formatCost` (lib/format.ts) already knows how to print.
 */
import { formatCost } from '$lib/format';

/**
 * numeric(18,6) decimal string -> integer micro-units (exact, no float).
 *
 * The column ALREADY counts micro-units (schema.ts: "$0.15 per 1M input tokens
 * -> input_price '150000.000000' (micro-USD)"), so this is a fixed-point
 * round to whole micro-units — not a dollars→micro scale-up.
 */
export function microDecimalToBigInt(value: string): bigint {
	const s = value.trim();
	const neg = s.startsWith('-');
	const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
	// Shift the 6 decimal digits up, round half-up, shift back down.
	const shifted = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
	const micro = (shifted + 500_000n) / 1_000_000n;
	return neg ? -micro : micro;
}

/** A per-1M price as currency, e.g. "$2.00". Null prints as an em dash. */
export function formatPricePer1M(value: string | null, currency = 'USD'): string {
	if (value === null) return '—';
	return formatCost(microDecimalToBigInt(value), currency);
}

/** Availability ratio (0..1) as a percentage with one decimal; null = no data. */
export function formatAvailability(ratio: number | null): string {
	if (ratio === null) return '—';
	return `${(ratio * 100).toFixed(1)}%`;
}

/** Latency in ms, grouped; null = no observed data. */
export function formatMs(ms: number | null): string {
	if (ms === null) return '—';
	return `${ms.toLocaleString('en-US')} ms`;
}

/** Context window in whole k tokens (500000 -> "500k"); null = unknown. */
export function formatContext(tokens: number | null): string {
	if (tokens === null) return '—';
	return `${Math.round(tokens / 1000).toLocaleString('en-US')}k`;
}
