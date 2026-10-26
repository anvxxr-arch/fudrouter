// packages/platform/test/scheduler-cadence.test.mjs
//
// The clamp behind the one configurable periodic cadence.
//
// Why this is worth pinning: the setting lives in `system_setting` as a JSON
// number an operator types into a console field. Everything that can be wrong
// with that — a typo, a unit mistake (30 meaning seconds), a stale row from a
// half-finished edit — arrives here as `unknown`. The rule is that anything
// unusable resolves to the DEFAULT rather than to the nearest bound, so a
// mistake is visibly inert instead of silently becoming the most aggressive
// cadence available.
//
// Run: node --test packages/platform/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	clampHealthCheckMs,
	HEALTH_CHECK_MIN_MS,
	HEALTH_CHECK_MAX_MS,
	HEALTH_CHECK_DEFAULT_MS
} from '../server/health-check-cadence.ts';

test('the bounds are what the design states', () => {
	assert.equal(HEALTH_CHECK_MIN_MS, 60_000, 'floor is 1 minute');
	assert.equal(HEALTH_CHECK_MAX_MS, 30 * 60_000, 'ceiling is 30 minutes');
	assert.equal(HEALTH_CHECK_DEFAULT_MS, 5 * 60_000, 'default is the old constant');
});

test('a value inside the range passes through', () => {
	assert.equal(clampHealthCheckMs(60_000), 60_000);
	assert.equal(clampHealthCheckMs(300_000), 300_000);
	assert.equal(clampHealthCheckMs(90_000), 90_000);
	assert.equal(clampHealthCheckMs(1_800_000), 1_800_000);
});

test('a fractional value is rounded, not rejected', () => {
	assert.equal(clampHealthCheckMs(90_000.4), 90_000);
	assert.equal(clampHealthCheckMs(90_000.6), 90_001);
});

test('out-of-range falls back to the default, not to the nearest bound', () => {
	// 30 meaning SECONDS is the likeliest operator mistake. It must not become
	// the 1-minute floor.
	assert.equal(clampHealthCheckMs(30_000), HEALTH_CHECK_DEFAULT_MS);
	assert.equal(clampHealthCheckMs(30), HEALTH_CHECK_DEFAULT_MS);
	// A value that would quietly disable the probe.
	assert.equal(clampHealthCheckMs(86_400_000), HEALTH_CHECK_DEFAULT_MS);
	assert.equal(clampHealthCheckMs(Number.MAX_SAFE_INTEGER), HEALTH_CHECK_DEFAULT_MS);
});

test('zero and negative fall back to the default', () => {
	assert.equal(clampHealthCheckMs(0), HEALTH_CHECK_DEFAULT_MS);
	assert.equal(clampHealthCheckMs(-1), HEALTH_CHECK_DEFAULT_MS);
	assert.equal(clampHealthCheckMs(-300_000), HEALTH_CHECK_DEFAULT_MS);
});

test('non-numbers fall back to the default', () => {
	for (const bad of [null, undefined, 'abc', '', {}, [], true, false, NaN, Infinity, -Infinity]) {
		assert.equal(
			clampHealthCheckMs(bad),
			HEALTH_CHECK_DEFAULT_MS,
			`${JSON.stringify(bad) ?? String(bad)} must be inert`
		);
	}
});

test('a numeric string is rejected, not coerced', () => {
	// A JSON column can legitimately hold "300000" as a string if someone
	// hand-edits the row. Coercing it would make the setting depend on JS
	// type juggling; rejecting it keeps one rule.
	assert.equal(clampHealthCheckMs('300000'), HEALTH_CHECK_DEFAULT_MS);
	assert.equal(clampHealthCheckMs('60000'), HEALTH_CHECK_DEFAULT_MS);
});
