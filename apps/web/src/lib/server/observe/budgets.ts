/**
 * Budget periods and threshold states (PRD §40).
 *
 * Pure rule module. Period windows are EXPLICITLY UTC (PRD §120: usage and
 * billing periods must pin a timezone): daily = midnight UTC, weekly = Monday
 * 00:00 UTC, monthly = the 1st 00:00 UTC. The clock is always passed in so
 * tests never sleep.
 *
 * Money is bigint micro-units; the percent is integer math (consumed * 100 /
 * amount) — no float touches a budget figure.
 */

export const BUDGET_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_ACTIONS = ['notify', 'restrict', 'block'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
	daily: 'Daily',
	weekly: 'Weekly',
	monthly: 'Monthly'
};

export const BUDGET_ACTION_LABELS: Record<BudgetAction, string> = {
	notify: 'Notify',
	restrict: 'Restrict',
	block: 'Block'
};

/** The consumption window for a budget period, in UTC, ending at `now`. */
export function periodWindow(period: BudgetPeriod, now: Date): { from: Date; to: Date } {
	const to = now;
	const y = now.getUTCFullYear();
	const mo = now.getUTCMonth();
	const d = now.getUTCDate();
	if (period === 'daily') return { from: new Date(Date.UTC(y, mo, d)), to };
	if (period === 'weekly') {
		// getUTCDay(): 0 = Sunday … 6 = Saturday. Monday start = back 0..6 days.
		const daysSinceMonday = (now.getUTCDay() + 6) % 7;
		return { from: new Date(Date.UTC(y, mo, d - daysSinceMonday)), to };
	}
	return { from: new Date(Date.UTC(y, mo, 1)), to };
}

export type BudgetState = 'ok' | 'warn' | 'critical' | 'exceeded';

/**
 * Threshold state for current consumption against the amount:
 * 100%+ = exceeded (the `action_at_100` fires), >= critical% = critical,
 * >= warn% = warn. Percent is integer math so 70% of 100 is exactly 70.
 */
export function budgetState(
	consumedMicro: bigint,
	amountMicro: bigint,
	warnPercent: number,
	criticalPercent: number
): BudgetState {
	if (amountMicro <= 0n) return consumedMicro > 0n ? 'exceeded' : 'ok';
	const percent = Number((consumedMicro * 100n) / amountMicro);
	if (percent >= 100) return 'exceeded';
	if (percent >= criticalPercent) return 'critical';
	if (percent >= warnPercent) return 'warn';
	return 'ok';
}

/** Consumed percent of amount, 0 when the amount is not positive. */
export function budgetPercent(consumedMicro: bigint, amountMicro: bigint): number {
	if (amountMicro <= 0n) return 0;
	return Number((consumedMicro * 100n) / amountMicro);
}
