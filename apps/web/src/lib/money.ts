/**
 * Money parsing for form inputs (micro-units, PRD conventions).
 *
 * Money never touches a float: this is exact decimal-string → bigint
 * arithmetic. "12.50" means 12_500_000 micro-units; "0.000001" is 1.
 */
export function parseMicros(input: string): bigint | null {
	const s = input.trim();
	if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
	const [whole, frac = ''] = s.split('.');
	return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** Inverse of parseMicros for form round-trips: 12_500_000n -> "12.5". */
export function microsToInput(value: bigint): string {
	const whole = value / 1_000_000n;
	const frac = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : whole.toString();
}
