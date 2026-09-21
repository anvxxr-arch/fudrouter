import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens } from './format';

describe('formatCost', () => {
	it('formats zero', () => {
		expect(formatCost(0n)).toBe('$0.00');
	});

	it('formats sub-cent amounts as $0.00 rather than scientific notation', () => {
		expect(formatCost(150n)).toBe('$0.00'); // $0.00015
		expect(formatCost(456n)).toBe('$0.00'); // $0.000456
	});

	it('formats whole and fractional micro-units exactly', () => {
		expect(formatCost(1_500_000n)).toBe('$1.50');
		expect(formatCost(438n)).toBe('$0.00');
		expect(formatCost(2_468n)).toBe('$0.00'); // $0.002468
	});

	it('does not lose precision on large values', () => {
		// $12,345,678.90 — a naive Number(micro)/1e6 would still be exact here,
		// but the split keeps it exact for values past 2^53 micro-units.
		expect(formatCost(12_345_678_900_000n)).toBe('$12,345,678.90');
	});

	it('honours the currency argument', () => {
		expect(formatCost(1_500_000n, 'EUR')).toContain('1.50');
	});
});

describe('formatTokens', () => {
	it('groups thousands', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(1234)).toBe('1,234');
		expect(formatTokens(1_000_000)).toBe('1,000,000');
	});
});
