import { describe, expect, it } from 'vitest';
import {
	currencySymbol,
	decodeCursor,
	encodeCursor,
	formatMicro,
	formatMicroSigned,
	ledgerLine,
	microToDecimal,
	typeLabel
} from './billing-format';

describe('ledger history shape (PRD §48)', () => {
	it('renders the PRD history line verbatim', () => {
		// "+$100.00 credit purchase / -$0.00421 request usage …"
		const purchase = ledgerLine({ type: 'credit_purchase', amountMicro: 100_000_000n, currency: 'USD' });
		expect(purchase.line).toBe('+$100.00 credit purchase');
		const usage = ledgerLine({ type: 'usage_charge', amountMicro: -4_210n, currency: 'USD' });
		expect(usage.line).toBe('-$0.00421 request usage');
	});
	it('names every ledger type the way the history reads', () => {
		expect(typeLabel('credit_purchase')).toBe('credit purchase');
		expect(typeLabel('usage_charge')).toBe('request usage');
		expect(typeLabel('adjustment')).toBe('adjustment');
		expect(typeLabel('refund')).toBe('refund');
		expect(typeLabel('promotion')).toBe('promotion');
		expect(typeLabel('expiration')).toBe('expiration');
		expect(typeLabel('anything-else')).toBe('anything-else');
	});
});

describe('micro-unit money formatting', () => {
	it('never rounds a sub-cent amount to zero', () => {
		expect(formatMicroSigned(-4_210n)).toBe('-$0.00421');
		expect(formatMicroSigned(-1n)).toBe('-$0.000001');
		expect(formatMicro(4_210n)).toBe('$0.00421');
	});
	it('shows sign for movements and cents for whole amounts', () => {
		expect(formatMicroSigned(100_000_000n)).toBe('+$100.00');
		expect(formatMicroSigned(-100_000_000n)).toBe('-$100.00');
		expect(formatMicroSigned(0n)).toBe('$0.00');
		expect(formatMicro(100_000_000n)).toBe('$100.00');
		expect(formatMicro(1_500_000n)).toBe('$1.50');
	});
	it('renders form values as plain decimals, symbol-free', () => {
		expect(microToDecimal(100_000_000n)).toBe('100.00');
		expect(microToDecimal(500_000n)).toBe('0.50');
		expect(microToDecimal(4_210n)).toBe('0.00421');
		expect(microToDecimal(4_210_000n)).toBe('4.21');
		expect(microToDecimal(-5_500_000n)).toBe('-5.50');
	});
	it('falls back to the currency code when Intl has no symbol', () => {
		expect(currencySymbol('ZZZ')).toBe('ZZZ');
	});
});

describe('transaction cursors', () => {
	it('round-trips the (created_at key, id) keyset with microsecond precision', () => {
		const key = '2026-09-30 12:34:56.789012+00';
		const id = 'txn_0189abc';
		const token = encodeCursor(key, id);
		expect(decodeCursor(token)).toEqual({ createdAtKey: key, id });
	});
	it('rejects tampered or malformed tokens', () => {
		expect(decodeCursor('')).toBeNull();
		expect(decodeCursor('nonsense')).toBeNull();
		expect(decodeCursor('12:34|txn_0189abc')).toBeNull();
		expect(decodeCursor('2026-09-30 12:34:56.789012+00|not an id')).toBeNull();
	});
});
