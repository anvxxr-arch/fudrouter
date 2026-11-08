// packages/platform/test/grant.test.mjs — the subscription grant writer (B2).
//
// Why this file exists: `grantForPayment` is the WRITE half of a settled
// payment — it turns the resolved grant into a persisted window sold under
// `frsubs`. The four cases below pin the money-safety contract in the order
// payments.ts `resolveGrant` already defines: success (grant + bucket), error
// (unknown plan), warn (amount mismatch), unknown (replay = no second grant).
//
// The writer is an in-memory stand-in with the SAME durable idempotency rule as
// the drizzle-backed one (0038: one payment_id = one subscription), so the test
// asserts the DECISION and the idempotency without a database.
//
// Flat top-level tests (no nesting): node:test only runs a nested `test()` when
// the parent awaits it, and a synchronous parent completes first.
//
// Run: node --test packages/platform/test/grant.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grantForPayment, SUBSCRIPTION_BUCKET, drizzleSubscriptionWriter } from '../server/grant.ts';
import { PLANS } from '../server/payments.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

// The four-category convention from payments.test.mjs: success / error / warn /
// unknown. `error` = hard stop (money must not move), `warn` = refuse with a
// follow-up, `unknown` = a state we cannot act on.

/** In-memory writer with the 0038 idempotency contract. */
function fakeWriter() {
	const byPayment = new Map();
	return {
		grant: async (args) => {
			// One payment_id = one subscription, enforced by the partial UNIQUE
			// index 0038 in production; the stand-in mirrors the same rule.
			if (byPayment.has(args.paymentId)) {
				return { id: byPayment.get(args.paymentId), created: false };
			}
			const id = `sub_${byPayment.size + 1}`;
			byPayment.set(args.paymentId, id);
			return { id, created: true };
		}
	};
}

const PAY_7D = {
	accountId: 'acc_alice',
	paymentId: 'pay_7d_1',
	plan: 'sub_7d',
	amountIdr: PLANS.sub_7d.priceIdr
};

// --- success ----------------------------------------------------------------

test('grant: success — a 7d payment writes a frsubs window', async () => {
	const w = fakeWriter();
	const r = await grantForPayment(w, PAY_7D, NOW);

	assert.equal(r.ok, true);
	assert.equal(r.bucket, SUBSCRIPTION_BUCKET);
	assert.equal(r.bucket, 'frsubs');
	assert.equal(r.plan, 'sub_7d');
	assert.equal(r.days, 7);
	assert.equal(r.priceIdr, 30000);
	assert.equal(r.expiresAt.toISOString(), '2026-11-16T12:00:00.000Z');
	assert.equal(r.created, true);
	assert.ok(r.subscriptionId.startsWith('sub_'), 'the id must carry the subscription prefix');
});

test('grant: success — the frsubs bucket is written on the window, not frpayg', async () => {
	// The acceptance criterion from FR-revised §6 S2: "beli 7d → resolve ke
	// BucketSubs, bukan frpayg". The writer pins the tier at grant time; the
	// Go data plane reads the persisted `economic_bucket` at admission.
	const w = fakeWriter();
	const r = await grantForPayment(w, PAY_7D, NOW);
	assert.equal(r.bucket, 'frsubs');
	assert.notEqual(r.bucket, 'frpayg');
});

// --- error ------------------------------------------------------------------

test('grant: error — an unknown plan is refused, never granted', async () => {
	const r = await grantForPayment(fakeWriter(), { ...PAY_7D, plan: 'sub_999d' }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_plan', 'the reason is resolveGrant\'s, not a local copy');
});

// --- warn -------------------------------------------------------------------

test('grant: warn — an amount mismatch is refused (reuse resolveGrant)', async () => {
	const r = await grantForPayment(fakeWriter(), { ...PAY_7D, amountIdr: 1000 }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'amount_mismatch', 'a short payment must never grant');
});

// --- unknown (replay / idempotency) ------------------------------------------

test('grant: unknown — a replayed payment returns the same window, not a second', async () => {
	const w = fakeWriter();
	const first = await grantForPayment(w, PAY_7D, NOW);
	const second = await grantForPayment(w, PAY_7D, NOW);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(second.created, false, 'the second delivery must not mint a grant');
	assert.equal(second.subscriptionId, first.subscriptionId, 'one payment_id, one subscription_id');
	assert.equal(second.bucket, 'frsubs');
});

test('grant: unknown — a null/missing plan is refused, not thrown on', async () => {
	// grantForPayment delegates fully to resolveGrant; an empty plan resolves to
	// unknown_plan rather than a crash.
	const r = await grantForPayment(fakeWriter(), { ...PAY_7D, plan: '' }, NOW);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_plan');
});

// --- drizzle writer seam -----------------------------------------------------

test('drizzle writer: the persist seam is exported for the webhook receiver', () => {
	// The writer is a certifiable surface, not just a data shape: the seam is
	// what a test supplies and the webhook receiver (B3a/B3b) replaces with the
	// real Postgres-backed writer.
	assert.equal(typeof drizzleSubscriptionWriter, 'function');
});