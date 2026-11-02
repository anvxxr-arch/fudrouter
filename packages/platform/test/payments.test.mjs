// packages/platform/test/payments.test.mjs — the four-case contract (criterion 3).
//
// Why this file exists: `resolveGrant` decides whether money becomes service,
// and `qrisFor` builds the payload a member actually pays. A bug in either
// either gives away the product or takes money without delivering. Both are
// worse than a crash, so every branch is pinned: success, error, warn, unknown.
//
// Flat top-level tests (no nesting): node:test runs a nested `test()` only if
// the parent awaits it, and a synchronous parent completes first — the subtests
// then report as cancelled. One level, one name per case.
//
// Run: node --test packages/platform/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	PLANS,
	PLAN_IDS,
	planOf,
	qrisFor,
	crc16,
	resolveGrant,
	isChannel,
	CHANNELS,
	approvalAction,
	QRIS_MERCHANT_PAYLOAD
} from '../server/payments.ts';

const NOW = new Date('2026-10-31T12:00:00Z');

// --- plan table -------------------------------------------------------------

test('plans: success — the five owner-priced plans are present', () => {
	assert.deepEqual(PLAN_IDS, ['sub_1d', 'sub_3d', 'sub_7d', 'sub_14d', 'sub_28d']);
	assert.equal(PLANS.sub_1d.priceIdr, 5000);
	assert.equal(PLANS.sub_3d.priceIdr, 12000);
	assert.equal(PLANS.sub_7d.priceIdr, 30000);
	assert.equal(PLANS.sub_14d.priceIdr, 50000);
	assert.equal(PLANS.sub_28d.priceIdr, 90000);
});

test('plans: unknown — an unlisted id resolves to null, not a default', () => {
	assert.equal(planOf('sub_999d'), null);
	assert.equal(planOf(''), null);
	assert.equal(planOf(undefined), null);
});

// --- crc16 ------------------------------------------------------------------

test('crc16: success — the EMVCo check value for a known vector', () => {
	// "123456789" is the canonical CRC-16/CCITT-FALSE vector -> 0x29B1.
	assert.equal(crc16('123456789'), '29B1');
});

test('crc16: unknown — an empty input still returns four hex digits', () => {
	assert.match(crc16(''), /^[0-9A-F]{4}$/);
});

// --- qrisFor ----------------------------------------------------------------

test('qris: success — the amount is injected as tag 54 and the CRC recomputed', () => {
	const out = qrisFor(30000);
	assert.ok(out, 'expected a payload');
	assert.match(out, /540530000/, 'tag 54 must carry the amount');
	assert.equal(out.slice(-4), crc16(out.slice(0, -4)));
});

test('qris: success — the merchant identity is preserved verbatim', () => {
	const out = qrisFor(5000);
	assert.ok(out.includes('LEV. SPACE, Jakarta'));
	assert.ok(out.includes('5802ID'));
});

test('qris: error — a zero amount is refused', () => {
	assert.equal(qrisFor(0), null);
});

test('qris: unknown — a negative or non-numeric amount is refused', () => {
	assert.equal(qrisFor(-1), null);
	assert.equal(qrisFor('abc'), null);
	assert.equal(qrisFor(undefined), null);
});

test('qris: warn — a fractional amount is rounded to whole rupiah', () => {
	// 5000.6 -> "5001" (4 chars) -> tag 54, length 04, value 5001.
	assert.match(qrisFor(5000.6), /54045001/, 'must round to 5001');
});

// --- resolveGrant -----------------------------------------------------------

test('grant: success — a confirmed payment at the exact price grants the window', () => {
	const r = resolveGrant({ plan: 'sub_7d', status: 'confirmed', amountIdr: 30000 }, NOW);
	assert.equal(r.ok, true);
	assert.equal(r.days, 7);
	assert.equal(r.priceIdr, 30000);
	assert.equal(r.expiresAt.toISOString(), '2026-11-07T12:00:00.000Z');
});

test('grant: error — a short payment is refused (amount mismatch)', () => {
	const r = resolveGrant({ plan: 'sub_7d', status: 'confirmed', amountIdr: 1000 }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'amount_mismatch');
});

test('grant: warn — a pending payment is refused, not granted', () => {
	const r = resolveGrant({ plan: 'sub_7d', status: 'pending', amountIdr: 30000 }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not_confirmed');
});

test('grant: unknown — an unknown plan is refused before any amount check', () => {
	const r = resolveGrant({ plan: 'sub_999d', status: 'confirmed', amountIdr: 30000 }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_plan');
});

test('grant: unknown — a null payment is refused, not thrown on', () => {
	assert.equal(resolveGrant(null, NOW).reason, 'no_payment');
	assert.equal(resolveGrant(undefined, NOW).reason, 'no_payment');
});

test('grant: error — a rejected payment is refused', () => {
	const r = resolveGrant({ plan: 'sub_1d', status: 'rejected', amountIdr: 5000 }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not_confirmed');
});

// --- approvalAction ---------------------------------------------------------

test('approval: success — yes grants and publishes the key', () => {
	const a = approvalAction('yes');
	assert.equal(a.grant, true);
	assert.equal(a.publishKey, true);
	assert.equal(a.followUp, false);
});

test('approval: error — no follows up and does not grant', () => {
	const a = approvalAction('no');
	assert.equal(a.grant, false);
	assert.equal(a.publishKey, false);
	assert.equal(a.followUp, true);
});

test('approval: unknown — an unrecognised answer fails closed to follow-up', () => {
	for (const bad of ['maybe', '', undefined, null, 'YES']) {
		const a = approvalAction(bad);
		assert.equal(a.grant, false, `answer ${bad} must not grant`);
		assert.equal(a.publishKey, false, `answer ${bad} must not publish`);
	}
});

// --- channels ---------------------------------------------------------------

test('channels: success — the four owner channels are accepted', () => {
	for (const c of CHANNELS) assert.equal(isChannel(c), true);
});

test('channels: unknown — an unlisted channel is refused', () => {
	assert.equal(isChannel('email'), false);
	assert.equal(isChannel(undefined), false);
});

// --- merchant payload -------------------------------------------------------

test('merchant: success — the pinned payload is the owner-supplied one', () => {
	assert.ok(QRIS_MERCHANT_PAYLOAD.startsWith('00020101021126610014COM.GO-JEK.WWW'));
	assert.ok(QRIS_MERCHANT_PAYLOAD.endsWith('63049B3A'));
});
