/**
 * Latency percentiles and cost math for the analytics pages (PRD §38–39).
 *
 * Pure functions, integer micro-units throughout — money never touches a float
 * (repo convention). The percentiles come from the fixed bucket histogram
 * (spec §8), which is what `usage_daily`/`usage_hourly` store and what the raw
 * rows are folded into, so both sources report the same way.
 */

/** Histogram buckets (ms upper bounds) from spec §8; `inf` is its sentinel key. */
export const HISTOGRAM_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 60000] as const;
export const INF_BUCKET = 'inf';

export function emptyHistogram(): Record<string, number> {
	const h: Record<string, number> = {};
	for (const b of HISTOGRAM_BUCKETS) h[String(b)] = 0;
	h[INF_BUCKET] = 0;
	return h;
}

/** Which bucket a latency lands in — the key the histogram map uses. */
export function histogramBucketFor(ms: number): string {
	for (const b of HISTOGRAM_BUCKETS) if (ms <= b) return String(b);
	return INF_BUCKET;
}

export function buildHistogram(latencies: Iterable<number>): Record<string, number> {
	const h = emptyHistogram();
	for (const ms of latencies) h[histogramBucketFor(ms)] += 1;
	return h;
}

/** Merge bucket maps additively; keys may be missing from either side. */
export function mergeHistograms(maps: Iterable<Record<string, number>>): Record<string, number> {
	const h: Record<string, number> = {};
	for (const m of maps) {
		for (const [bucket, n] of Object.entries(m)) h[bucket] = (h[bucket] ?? 0) + n;
	}
	return h;
}

/** Upper bound (ms) of a histogram bucket key; `inf` is Infinity. */
export function bucketBound(key: string): number {
	return key === INF_BUCKET ? Infinity : Number(key);
}

/**
 * Percentile from bucket counts (PRD §38). Nearest-rank over cumulative bucket
 * counts, returning the UPPER BOUND of the bucket holding the p-th observation
 * — an estimate by construction, which is why the UI labels it as such. A
 * quantile that falls in the open `inf` bucket has no finite bound and returns
 * null (rendered as "≥ 60 s", never as a fake number).
 */
export function percentileFromHistogram(h: Record<string, number>, p: number): number | null {
	const entries = Object.entries(h)
		.map(([bucket, n]) => [bucketBound(bucket), n] as const)
		.sort((a, b) => a[0] - b[0]);
	const total = entries.reduce((n, [, count]) => n + count, 0);
	if (total === 0) return null;
	const rank = Math.ceil((p / 100) * total);
	let cumulative = 0;
	for (const [bound, count] of entries) {
		cumulative += count;
		if (cumulative >= rank) return Number.isFinite(bound) ? bound : null;
	}
	return null;
}

// --------------------------------------------------------- cost analytics ---

export type UsageTotals = {
	requests: number;
	tokensIn: number;
	cachedInputTokens: number;
	tokensOut: number;
	reasoningTokens: number;
	totalTokens: number;
	costMicro: bigint;
	successes: number;
	latencyMsSum: number;
	ttftMsSum: number;
	fallbackCount: number;
	retryCount: number;
	histogram: Record<string, number>;
};

export const EMPTY_TOTALS: UsageTotals = {
	requests: 0,
	tokensIn: 0,
	cachedInputTokens: 0,
	tokensOut: 0,
	reasoningTokens: 0,
	totalTokens: 0,
	costMicro: 0n,
	successes: 0,
	latencyMsSum: 0,
	ttftMsSum: 0,
	fallbackCount: 0,
	retryCount: 0,
	histogram: {}
};

/** Additive fold — aggregate rows and raw rows both land here. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		requests: a.requests + b.requests,
		tokensIn: a.tokensIn + b.tokensIn,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		tokensOut: a.tokensOut + b.tokensOut,
		reasoningTokens: a.reasoningTokens + b.reasoningTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		costMicro: a.costMicro + b.costMicro,
		successes: a.successes + b.successes,
		latencyMsSum: a.latencyMsSum + b.latencyMsSum,
		ttftMsSum: a.ttftMsSum + b.ttftMsSum,
		fallbackCount: a.fallbackCount + b.fallbackCount,
		retryCount: a.retryCount + b.retryCount,
		histogram: mergeHistograms([a.histogram, b.histogram])
	};
}

export type CostMetrics = {
	totalSpendMicro: bigint;
	costPerRequestMicro: bigint;
	costPer1mTokensMicro: bigint;
	/** What the upstream charged us; null when the source cannot report it. */
	providerCostMicro: bigint | null;
	/** Customer charge minus provider cost; null when provider cost is unknown. */
	markupMicro: bigint | null;
};

/**
 * Cost analytics (PRD §39) from a totals fold, all in integer micro-units so
 * the reconciliation test asserts the same arithmetic the page renders.
 * `costPer1mTokensMicro` is micro-units of currency per 1M tokens; integer
 * division would zero out, so scale by 1e6 before dividing — still exact.
 * `providerCostMicro` comes from a separate sum of `request_log.provider_cost_micro`
 * (the aggregate tables do not carry it, hence nullable rather than a zero that
 * would read as "the provider charged nothing").
 */
export function costMetrics(t: UsageTotals, providerCostMicro: bigint | null): CostMetrics {
	return {
		totalSpendMicro: t.costMicro,
		costPerRequestMicro: t.requests > 0 ? t.costMicro / BigInt(t.requests) : 0n,
		costPer1mTokensMicro:
			t.totalTokens > 0 ? (t.costMicro * 1_000_000n) / BigInt(t.totalTokens) : 0n,
		providerCostMicro,
		markupMicro: providerCostMicro == null ? null : t.costMicro - providerCostMicro
	};
}
