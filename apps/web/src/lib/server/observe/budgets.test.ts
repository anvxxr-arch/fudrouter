import { describe, expect, it } from 'vitest';
import { budgetPercent, budgetState, periodWindow, type BudgetPeriod } from './budgets';

describe('budget period windows are UTC (PRD §120)', () => {
	// Wednesday 2026-09-30, mid-afternoon UTC.
	const now = new Date('2026-09-30T15:30:00.000Z');
	const iso = (d: Date) => d.toISOString();

	it('daily starts at midnight UTC and runs to now', () => {
		const w = periodWindow('daily', now);
		expect(iso(w.from)).toBe('2026-09-30T00:00:00.000Z');
		expect(w.to).toBe(now);
	});
	it('weekly starts on Monday 00:00 UTC', () => {
		expect(iso(periodWindow('weekly', now).from)).toBe('2026-09-28T00:00:00.000Z');
		// Sunday itself belongs to the week that started the prior Monday.
		const sunday = new Date('2026-10-04T01:00:00.000Z');
		expect(iso(periodWindow('weekly', sunday).from)).toBe('2026-09-28T00:00:00.000Z');
		// And a Monday starts its own week.
		const monday = new Date('2026-10-05T23:59:00.000Z');
		expect(iso(periodWindow('weekly', monday).from)).toBe('2026-10-05T00:00:00.000Z');
	});
	it('monthly starts on the 1st 00:00 UTC', () => {
		expect(iso(periodWindow('monthly', now).from)).toBe('2026-09-01T00:00:00.000Z');
	});
	it('covers every period key without a default branch guess', () => {
		for (const p of ['daily', 'weekly', 'monthly'] as BudgetPeriod[]) {
			const w = periodWindow(p, now);
			expect(w.from.getTime()).toBeLessThanOrEqual(now.getTime());
		}
	});
});

describe('budget thresholds', () => {
	const M = (n: number) => BigInt(n);
	it('walks ok -> warn -> critical -> exceeded on integer percent math', () => {
		// amount 100, warn 70, critical 90 (defaults).
		expect(budgetState(M(69), M(100), 70, 90)).toBe('ok');
		expect(budgetState(M(70), M(100), 70, 90)).toBe('warn');
		expect(budgetState(M(89), M(100), 70, 90)).toBe('warn');
		expect(budgetState(M(90), M(100), 70, 90)).toBe('critical');
		expect(budgetState(M(99), M(100), 70, 90)).toBe('critical');
		expect(budgetState(M(100), M(100), 70, 90)).toBe('exceeded');
		expect(budgetState(M(250), M(100), 70, 90)).toBe('exceeded');
	});
	it('treats a non-positive amount as a cliff, not an infinite budget', () => {
		expect(budgetState(M(0), M(0), 70, 90)).toBe('ok');
		expect(budgetState(M(1), M(0), 70, 90)).toBe('exceeded');
		expect(budgetState(M(1), M(-5), 70, 90)).toBe('exceeded');
	});
	it('reports the consumed percentage exactly', () => {
		expect(budgetPercent(M(50), M(200))).toBe(25);
		expect(budgetPercent(M(0), M(200))).toBe(0);
		expect(budgetPercent(M(7), M(0))).toBe(0);
		expect(budgetPercent(M(333_333), M(1_000_000))).toBe(33);
	});
});
