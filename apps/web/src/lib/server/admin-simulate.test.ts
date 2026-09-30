import { afterEach, describe, expect, it } from 'vitest';
import {
	estimateCostMicro,
	simulateRouting,
	type SimCandidate,
	type SimStore
} from './admin-simulate';

const candidates: SimCandidate[] = [
	{
		providerId: 'prv_a',
		providerName: 'Alpha',
		providerPriority: 10,
		connectionId: 'con_a',
		connectionName: 'alpha-us',
		providerModelId: 'pmdl_a',
		inputPriceMicro: 300_000n,
		outputPriceMicro: 1_500_000n,
		availability: 0.99,
		p95LatencyMs: 400,
		healthStatus: 'healthy',
		enabled: true
	},
	{
		providerId: 'prv_b',
		providerName: 'Beta',
		providerPriority: 50,
		connectionId: null,
		connectionName: null,
		providerModelId: 'pmdl_b',
		inputPriceMicro: 100_000n,
		outputPriceMicro: 500_000n,
		availability: 0.9,
		p95LatencyMs: 900,
		healthStatus: 'degraded',
		enabled: true
	},
	{
		providerId: 'prv_c',
		providerName: 'Gamma',
		providerPriority: 30,
		connectionId: 'con_c',
		connectionName: 'gamma-eu',
		providerModelId: 'pmdl_c',
		inputPriceMicro: 200_000n,
		outputPriceMicro: 800_000n,
		availability: 0.5,
		p95LatencyMs: 300,
		healthStatus: 'unhealthy',
		enabled: false
	}
];

function stubStore(calls: string[]): SimStore {
	return {
		candidates: async (modelId: string) => {
			calls.push(`candidates:${modelId}`);
			return candidates;
		}
	};
}

afterEach(() => {
	// @ts-expect-error test cleanup of the fetch spy
	delete globalThis.fetch;
});

describe('simulateRouting', () => {
	it('returns candidates through the store alone — no fetch, no inference call', async () => {
		const calls: string[] = [];
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches += 1;
			throw new Error('the simulator must never reach the network');
		}) as unknown as typeof fetch;
		const result = await simulateRouting(stubStore(calls), {
			modelId: 'mdl_x',
			inputTokens: 1000,
			outputTokens: 500,
			strategy: 'balanced'
		});
		expect(fetches).toBe(0);
		expect(calls).toEqual(['candidates:mdl_x']);
		expect(result.candidatesConsidered).toBe(3);
		expect(result.rows.map((r) => r.providerId).sort()).toEqual(['prv_a', 'prv_b', 'prv_c']);
		for (const row of result.rows) expect(row.reason.length).toBeGreaterThan(0);
	});
	it('estimates cost from the token estimate in bigint micro-units', async () => {
		const result = await simulateRouting(stubStore([]), {
			modelId: 'mdl_x',
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			strategy: 'lowest_cost'
		});
		const alpha = result.rows.find((r) => r.providerId === 'prv_a')!;
		const beta = result.rows.find((r) => r.providerId === 'prv_b')!;
		expect(alpha.estimatedCostMicro).toBe(1_800_000n);
		expect(beta.estimatedCostMicro).toBe(600_000n);
		// Cheapest candidate wins under lowest_cost.
		expect(result.rows[0].providerId).toBe('prv_b');
	});
	it('ranks latency under lowest_latency and never routes a disabled mapping', async () => {
		const result = await simulateRouting(stubStore([]), {
			modelId: 'mdl_x',
			inputTokens: 10,
			outputTokens: 10,
			strategy: 'lowest_latency'
		});
		const disabled = result.rows.find((r) => r.providerId === 'prv_c')!;
		expect(disabled.score).toBe(0);
		expect(disabled.reason).toContain('disabled');
		const enabled = result.rows.filter((r) => r.score > 0);
		expect(enabled[0].providerId).toBe('prv_a');
	});
	it('estimateCostMicro floors at zero and truncates token estimates', () => {
		const c = candidates[0];
		expect(estimateCostMicro(c, -5, 0)).toBe(0n);
		expect(estimateCostMicro(c, 0.9, 0.9)).toBe(0n);
		expect(estimateCostMicro(c, 2_000_000, 0)).toBe(600_000n);
	});
});
