import { describe, expect, it } from 'vitest';
import {
	formatAvailability,
	formatContext,
	formatMs,
	formatPricePer1M,
	microDecimalToBigInt
} from './public-format';
describe('public display formatting', () => {
	it('converts numeric(18,6) micro decimals exactly', () => {
		// The column counts micro-units already: 2000000 micro-USD = $2.00.
		expect(microDecimalToBigInt('2000000.000000')).toBe(2000000n);
		expect(microDecimalToBigInt('150000.000000')).toBe(150000n);
		expect(microDecimalToBigInt('0.500000')).toBe(1n); // half-up
		expect(microDecimalToBigInt('1234567890.123456')).toBe(1234567890n);
	});
	it('formats a per-1M price as currency and null as a dash', () => {
		// 2000000 micro-USD per 1M tokens = $2.00 per 1M.
		expect(formatPricePer1M('2000000.000000')).toBe('$2.00');
		expect(formatPricePer1M(null)).toBe('—');
	});
	it('formats availability, latency and context with honest nulls', () => {
		expect(formatAvailability(0.987)).toBe('98.7%');
		expect(formatAvailability(null)).toBe('—');
		expect(formatMs(1234)).toBe('1,234 ms');
		expect(formatMs(null)).toBe('—');
		expect(formatContext(500000)).toBe('500k');
		expect(formatContext(null)).toBe('—');
	});
});
