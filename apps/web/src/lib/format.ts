/**
 * Cost is stored as an integer in micro-units of the currency (1e-6), matching
 * the Go data plane's `cost.Compute`. Never do float math on the raw bigint —
 * convert to a Number only after splitting whole and fractional parts, or large
 * values lose precision before they are even formatted.
 */
export function formatCost(micro: bigint, currency = 'USD'): string {
	const whole = micro / 1_000_000n;
	const frac = micro % 1_000_000n;
	const value = Number(whole) + Number(frac) / 1_000_000;
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

export function formatTokens(n: number): string {
	return new Intl.NumberFormat('en-US').format(n);
}

/** Format a Date as "YYYY-MM-DD HH:MM:SS" for display in tables. */
export const formatDateTime = (date: Date) =>
	date.toISOString().replace('T', ' ').slice(0, 19);

/** Format a Date as "YYYY-MM-DD" for display. */
export const formatDate = (date: Date) => date.toISOString().slice(0, 10);
