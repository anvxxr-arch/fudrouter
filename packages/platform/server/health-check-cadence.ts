/**
 * Cadence bounds and the clamp for the one configurable periodic job,
 * `provider_health_check`.
 *
 * This lives in its own module, not beside `scheduler.ts`, because the clamp
 * is pure logic an operator's typed value has to survive, and importing
 * `scheduler.ts` drags in the database module (which throws without
 * DATABASE_URL). A unit test for "what happens when someone types 30 meaning
 * seconds" should not need a database.
 */

/**
 * The floor is 1 minute: at 17 connections that is 17 probe requests a
 * minute, the same order as one busy tenant's traffic, and a lower value
 * starts to look like abuse to the free-tier providers most of the fleet is.
 * The ceiling stops a value like 86400000 from quietly disabling the probe.
 *
 * Both are exported so the console can state the range without duplicating
 * the numbers.
 */
export const HEALTH_CHECK_MIN_MS = 60_000;
export const HEALTH_CHECK_MAX_MS = 30 * 60_000;
/** The cadence the scheduler constant carried before it became configurable. */
export const HEALTH_CHECK_DEFAULT_MS = 5 * 60_000;

/**
 * clampHealthCheckMs resolves an operator-supplied cadence to one the
 * scheduler will act on.
 *
 * Anything unusable — non-number, NaN, <= 0, or outside the bounds — returns
 * the DEFAULT, not the nearest bound. A typo must be visibly inert rather
 * than silently becoming the most aggressive setting available; an operator
 * who typed 30 expecting seconds gets 5 minutes and can see that nothing
 * changed, instead of getting a 1-minute probe they did not ask for.
 */
export function clampHealthCheckMs(v: unknown): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) return HEALTH_CHECK_DEFAULT_MS;
	if (v < HEALTH_CHECK_MIN_MS || v > HEALTH_CHECK_MAX_MS) return HEALTH_CHECK_DEFAULT_MS;
	return Math.round(v);
}
