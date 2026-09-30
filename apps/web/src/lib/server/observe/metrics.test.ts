import { describe, expect, it } from 'vitest';
import {
	addTotals,
	bucketBound,
	buildHistogram,
	costMetrics,
	EMPTY_TOTALS,
	histogramBucketFor,
	INF_BUCKET,
	mergeHistograms,
	percentileFromHistogram,
	type UsageTotals
} from './metrics';

describe('latency histogram (spec §8 buckets)', () => {
	it('assigns a latency to its bucket, upper bound inclusive', () => {
		expect(histogramBucketFor(0)).toBe('50');
		expect(histogramBucketFor(50)).toBe('50');
		expect(histogramBucketFor(51)).toBe('100');
		expect(histogramBucketFor(2500)).toBe('2500');
		expect(histogramBucketFor(60001)).toBe(INF_BUCKET);
	});
	it('folds a latency list into bucket counts', () => {
		const h = buildHistogram([10, 49, 50, 300, 9000, 120000]);
		expect(h['50']).toBe(3);
		expect(h['250']).toBe(0);
		expect(h['500']).toBe(1);
		expect(h['10000']).toBe(1);
		expect(h[INF_BUCKET]).toBe(1);
	});
	it('merges bucket maps additively, tolerating missing keys', () => {
		const merged = mergeHistograms([{ '50': 2, '100': 1 }, { '100': 3, inf: 1 }, {}]);
		expect(merged['50']).toBe(2);
		expect(merged['100']).toBe(4);
		expect(merged[INF_BUCKET]).toBe(1);
		expect(merged['250']).toBeUndefined();
	});
	it('treats inf as an open bound', () => {
		expect(bucketBound(INF_BUCKET)).toBe(Infinity);
		expect(bucketBound('250')).toBe(250);
	});
});

describe('percentiles from buckets (PRD §38)', () => {
	it('returns the upper bound of the bucket holding the rank', () => {
		// 10 samples at 30ms, 10 at 400ms: p50 lands in '50', p95 in '500'.
		const h = buildHistogram([...Array(10).fill(30), ...Array(10).fill(400)]);
		expect(percentileFromHistogram(h, 50)).toBe(50);
		expect(percentileFromHistogram(h, 95)).toBe(500);
		expect(percentileFromHistogram(h, 99)).toBe(500);
	});
	it('says null when the rank falls in the open inf bucket — never a fake number', () => {
		const h = buildHistogram([10, 20, 999999]);
		// p50 lands in the '50' bucket and reports its UPPER BOUND, not a sample.
		expect(percentileFromHistogram(h, 50)).toBe(50);
		expect(percentileFromHistogram(h, 99)).toBeNull();
	});
	it('says null for an empty histogram rather than zero latency', () => {
		expect(percentileFromHistogram({}, 95)).toBeNull();
		expect(percentileFromHistogram({ '50': 0, inf: 0 }, 95)).toBeNull();
	});
});

describe('totals folds', () => {
	const t = (n: Partial<UsageTotals>): UsageTotals => ({ ...EMPTY_TOTALS, ...n });
	it('adds every dimension, including histograms', () => {
		const sum = addTotals(t({ requests: 2, costMicro: 300n, histogram: { '50': 1 } }), t({
			requests: 3,
			costMicro: 700n,
			tokensIn: 42,
			histogram: { '50': 2, inf: 1 }
		}));
		expect(sum.requests).toBe(5);
		expect(sum.costMicro).toBe(1000n);
		expect(sum.tokensIn).toBe(42);
		expect(sum.histogram).toEqual({ '50': 3, inf: 1 });
	});
	it('is empty as its zero element', () => {
		expect(addTotals(EMPTY_TOTALS, EMPTY_TOTALS).costMicro).toBe(0n);
	});
});

describe('cost analytics math (PRD §39)', () => {
	it('is integer micro-units throughout', () => {
		const totals: UsageTotals = {
			...EMPTY_TOTALS,
			requests: 4,
			totalTokens: 2_000_000,
			costMicro: 1_000_000n
		};
		const m = costMetrics(totals, 600_000n);
		expect(m.totalSpendMicro).toBe(1_000_000n);
		expect(m.costPerRequestMicro).toBe(250_000n);
		// $1 of spend over 2M tokens = $0.50 per 1M tokens = 500_000 micro-units.
		expect(m.costPer1mTokensMicro).toBe(500_000n);
		expect(m.markupMicro).toBe(400_000n);
	});
	it('reports provider cost as unknown rather than free', () => {
		const totals: UsageTotals = { ...EMPTY_TOTALS, requests: 1, costMicro: 100n };
		const m = costMetrics(totals, null);
		expect(m.providerCostMicro).toBeNull();
		expect(m.markupMicro).toBeNull();
	});
	it('guards division by empty windows', () => {
		const m = costMetrics(EMPTY_TOTALS, 0n);
		expect(m.costPerRequestMicro).toBe(0n);
		expect(m.costPer1mTokensMicro).toBe(0n);
	});
});
