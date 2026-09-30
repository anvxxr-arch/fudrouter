import { describe, expect, it } from 'vitest';
import { numericMicros, pickPrice, rowToCandidate, type SimRow } from './admin-sim-store';

/**
 * The query → candidate shaping is pure so it can be pinned without a
 * database: price precedence (specific rule > model-wide rule > legacy
 * columns), numeric(18,6) truncation to bigint micros, and the "no traffic is
 * unknown, not dead" availability default.
 */
const baseRow: SimRow = {
	providerId: 'prv_a',
	providerName: 'Alpha',
	providerPriority: 10,
	connectionId: 'con_a',
	connectionName: 'alpha-us',
	providerModelId: 'pmdl_a',
	pmEnabled: true,
	healthStatus: 'healthy',
	specificPrice: null,
	widePrice: null,
	legacyInputPrice: '150000.000000',
	legacyOutputPrice: '750000.500000',
	successes: null,
	total: null,
	p95LatencyMs: null
};

describe('numericMicros', () => {
	it('truncates the scale-6 fraction to bigint micro-units', () => {
		expect(numericMicros('150000.000000')).toBe(150000n);
		expect(numericMicros('750000.500000')).toBe(750000n);
		expect(numericMicros('1')).toBe(1n);
	});
	it('falls back for null/garbage rather than throwing', () => {
		expect(numericMicros(null)).toBe(0n);
		expect(numericMicros(undefined)).toBe(0n);
		expect(numericMicros('')).toBe(0n);
		expect(numericMicros('abc')).toBe(0n);
		expect(numericMicros(null, 42n)).toBe(42n);
	});
});

describe('pickPrice', () => {
	it('falls back to the legacy model columns when no rule exists', () => {
		expect(pickPrice(baseRow)).toEqual({ inputPriceMicro: 150000n, outputPriceMicro: 750000n });
	});
	it('prefers the model-wide rule over the legacy columns', () => {
		const row: SimRow = {
			...baseRow,
			widePrice: { input: '100000.000000', output: '500000.000000' }
		};
		expect(pickPrice(row)).toEqual({ inputPriceMicro: 100000n, outputPriceMicro: 500000n });
	});
	it('prefers the provider-specific rule over the model-wide one (PRD §60: specific wins)', () => {
		const row: SimRow = {
			...baseRow,
			specificPrice: { input: '900000.000000', output: '450000.000000' },
			widePrice: { input: '100000.000000', output: '500000.000000' }
		};
		expect(pickPrice(row)).toEqual({ inputPriceMicro: 900000n, outputPriceMicro: 450000n });
	});
	it('falls back to the legacy columns for a rule field that is somehow null', () => {
		const row: SimRow = { ...baseRow, widePrice: { input: null, output: '600000.000000' } };
		expect(pickPrice(row)).toEqual({ inputPriceMicro: 150000n, outputPriceMicro: 600000n });
	});
});

describe('rowToCandidate', () => {
	it('treats zero recorded traffic as neutral availability, not a dead mapping', () => {
		const c = rowToCandidate({ ...baseRow, successes: 0, total: 0 });
		expect(c.availability).toBe(1);
		expect(c.p95LatencyMs).toBe(0);
		expect(c.healthStatus).toBe('healthy');
	});
	it('computes availability as successes/total, clamped to 0..1', () => {
		expect(rowToCandidate({ ...baseRow, successes: 9, total: 10 }).availability).toBeCloseTo(0.9);
		expect(rowToCandidate({ ...baseRow, successes: 0, total: 4 }).availability).toBe(0);
		expect(rowToCandidate({ ...baseRow, successes: 12, total: 10 }).availability).toBe(1);
	});
	it('reports a connectionless mapping as health "unknown" and keeps mapping identity', () => {
		const c = rowToCandidate({
			...baseRow,
			connectionId: null,
			connectionName: null,
			healthStatus: null,
			pmEnabled: false,
			p95LatencyMs: 320
		});
		expect(c.healthStatus).toBe('unknown');
		expect(c.connectionId).toBeNull();
		expect(c.enabled).toBe(false);
		expect(c.providerModelId).toBe('pmdl_a');
		expect(c.p95LatencyMs).toBe(320);
	});
});
