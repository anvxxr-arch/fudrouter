import { describe, expect, it } from 'vitest';
import {
	effectiveLimits,
	isSpendMetric,
	LIMIT_LABELS,
	LIMIT_LEVEL_LABELS,
	LIMIT_METRICS,
	NO_LIMITS,
	type LimitChainEntry,
	type LimitValues
} from './limits';

const level = (l: LimitChainEntry['level'], v: Partial<LimitValues>): LimitChainEntry => ({
	level: l,
	values: { ...NO_LIMITS, ...v }
});

describe('effective limit chain (spec §7)', () => {
	const chain: LimitChainEntry[] = [
		level('platform', { rpm: 1000, tpm: 1_000_000, concurrency: 64 }),
		level('workspace', { rpm: 500 }),
		level('project', { rpm: 200, tpm: 10_000 }),
		level('environment', { rpm: 300 }),
		level('api_key', { rpm: 50, dailySpendMicro: 25_000_000n })
	];
	const resolved = Object.fromEntries(effectiveLimits(chain).map((l) => [l.metric, l]));

	it('takes the minimum across the chain and names the level holding it', () => {
		expect(resolved.rpm.effective).toBe(50);
		expect(resolved.rpm.boundAt).toBe('api_key');
		expect(resolved.tpm.effective).toBe(10_000);
		expect(resolved.tpm.boundAt).toBe('project');
		expect(resolved.concurrency.effective).toBe(64);
		expect(resolved.concurrency.boundAt).toBe('platform');
	});
	it('never treats a missing value as zero — NULL inherits', () => {
		expect(resolved.rpd.effective).toBeNull();
		expect(resolved.rpd.boundAt).toBeNull();
		expect(resolved.monthlySpendMicro.effective).toBeNull();
		expect(resolved.dailySpendMicro.effective).toBe(25_000_000n);
		expect(resolved.dailySpendMicro.boundAt).toBe('api_key');
	});
	it('a level may tighten but never widen the chain above it', () => {
		// The environment wants 300 rpm while the project set 200: 200 wins.
		const envWants: LimitChainEntry[] = [
			level('platform', { rpm: 1000 }),
			level('project', { rpm: 200 }),
			level('environment', { rpm: 300 })
		];
		const rpm = effectiveLimits(envWants).find((l) => l.metric === 'rpm')!;
		expect(rpm.effective).toBe(200);
		expect(rpm.boundAt).toBe('project');
	});
	it('breaks a tie toward the most specific level, where it can be edited', () => {
		const tie: LimitChainEntry[] = [
			level('platform', { rpm: 100 }),
			level('workspace', { rpm: 100 })
		];
		const rpm = effectiveLimits(tie).find((l) => l.metric === 'rpm')!;
		expect(rpm.effective).toBe(100);
		expect(rpm.boundAt).toBe('workspace');
	});
	it('reports every level in byLevel so the chain table can show the blanks', () => {
		expect(resolved.rpm.byLevel).toEqual({
			platform: 1000,
			workspace: 500,
			project: 200,
			environment: 300,
			api_key: 50
		});
		expect(resolved.rpd.byLevel.environment).toBeNull();
	});
	it('covers exactly the metric list, one entry each', () => {
		expect(effectiveLimits([]).map((l) => l.metric)).toEqual([...LIMIT_METRICS]);
	});
});

describe('limit vocabulary', () => {
	it('knows which metrics are money and labels every one', () => {
		expect(isSpendMetric('dailySpendMicro')).toBe(true);
		expect(isSpendMetric('monthlySpendMicro')).toBe(true);
		expect(isSpendMetric('rpm')).toBe(false);
		for (const m of LIMIT_METRICS) expect(LIMIT_LABELS[m].length).toBeGreaterThan(0);
	});
	it('labels every level of the chain', () => {
		for (const l of ['platform', 'workspace', 'project', 'environment', 'api_key'] as const) {
			expect(LIMIT_LEVEL_LABELS[l].length).toBeGreaterThan(0);
		}
	});
});
