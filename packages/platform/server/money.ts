/**
 * Pure micro-unit money arithmetic, with no database dependency.
 *
 * Kept separate from billing.ts because billing.ts imports ./db/index.ts, which
 * throws at import time when DATABASE_URL is unset (see that module's header).
 * The platform-ts bridge and the unit tests import these pure functions with no
 * database at all, so a parse/ceiling rule must never transitively pull the pool.
 */

/**
 * Parse a human-entered decimal amount ("10", "10.50", "0.00421") into signed
 * micro-units. String arithmetic only — Number("0.00421") * 1e6 is 4210.000000001
 * in a float, and a ledger must never depend on that.
 *
 * Accepts at most 6 decimal places (one micro-unit); anything else is a typo,
 * not something to silently round. Returns null for anything unparseable.
 */
export function parseAmountToMicro(input: unknown): bigint | null {
	// `String(input ?? '')` mirrors the old .mjs writer, which accepted a bare
	// number/undefined form value; a parse helper must not throw where the caller
	// only handed it an untrusted form body.
	const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(input ?? '').trim());
	if (!m) return null;
	const [, sign, whole, frac = ''] = m;
	const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
	return sign === '-' ? -micro : micro;
}