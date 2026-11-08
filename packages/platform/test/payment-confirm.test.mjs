// packages/platform/test/payment-confirm.test.mjs — the confirm→grant loop (B3b).
//
// Why this file exists: `confirmAndGrant` is the step that closes the money
// loop — a VERIFIED gateway settlement (B3a) becomes one confirmed payment row,
// one subscription window sold under `frsubs`, and nothing else. The invariants
// pinned here are the ones a replayed or wrong settlement must never break:
//
//   1. one payment = one confirmed payment + one subscription (frsubs);
//   2. a replayed confirm mints no second window and no second payment;
//   3. an amount mismatch / unknown plan is refused BEFORE any write;
//   4. a payment with no internal id is "unknown", never a grant.
//
// The rule that decides WHAT may grant stays in payments.ts resolveGrant, reached
// through grantForPayment (B2) — confirmAndGrant does NOT re-encode it. The store
// and the write are injected so the four cases run in-memory; the real route
// supplies drizzlePaymentConfirmStore + drizzleSubscriptionWriter.
//
// Flat top-level tests (no nesting): node:test runs a nested test() only when
// the parent awaits it.
//
// Run: node --test packages/platform/test/payment-confirm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	confirmAndGrant,
	drizzlePaymentConfirmStore
} from '../server/payment-confirm.ts';
import { SUBSCRIPTION_BUCKET } from '../server/grant.ts';
import { PLANS } from '../server/payments.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

/** In-memory payment-confirm store: mirrors the idempotent UPDATE. */
function fakeStore() {
	const rows = new Map(); // id -> record
	let confirmCalls = 0;
	return {
		confirmCalls: () => confirmCalls,
		confirmedCount: () => [...rows.values()].filter((r) => r.status === 'confirmed').length,
		confirmPayment: async (record) => {
			confirmCalls += 1;
			const existing = rows.get(record.id);
			const was = existing?.status === 'confirmed';
			rows.set(record.id, { ...(existing ?? {}), ...record, status: 'confirmed' });
			return { id: record.id, alreadyConfirmed: was };
		}
	};
}

/** In-memory subscription writer with the 0038 idempotency contract. */
function fakeWriter() {
	const byPayment = new Map();
	let grantCalls = 0;
	return {
		grantCalls: () => grantCalls,
		grant: async (args) => {
			grantCalls += 1;
			if (byPayment.has(args.paymentId)) {
				return { id: byPayment.get(args.paymentId), created: false };
			}
			const id = `sub_${byPayment.size + 1}`;
			byPayment.set(args.paymentId, id);
			return { id, created: true };
		}
	};
}

const RECORD_7D = {
	id: 'pay_7d_1',
	gatewayRef: 'purchase:alice-7d',
	gateway: 'qris-native',
	accountId: 'acc_alice',
	channel: 'web',
	plan: 'sub_7d',
	amountIdr: PLANS.sub_7d.priceIdr,
	status: 'pending'
};

// --- (a) success: one payment, one subscription, frsubs bucket -----------------

test('confirm: success — one payment becomes one confirmed payment + one frsubs subscription', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const r = await confirmAndGrant({ store, now: NOW }, RECORD_7D, writer);

	assert.equal(r.ok, true);
	assert.equal(r.paymentId, 'pay_7d_1');
	assert.equal(r.paymentAlreadyConfirmed, false);
	assert.equal(r.grant.created, true);
	// The acceptance criterion (FR-revised §6 S3): the window sells under frsubs.
	assert.equal(r.grant.bucket, SUBSCRIPTION_BUCKET);
	assert.equal(r.grant.bucket, 'frsubs');
	assert.equal(r.grant.plan, 'sub_7d');
	assert.equal(r.grant.days, 7);
	assert.equal(r.grant.priceIdr, 30000);
	// One payment = one confirmed payment row + one subscription window.
	assert.equal(store.confirmedCount(), 1);
	assert.equal(store.confirmCalls(), 1);
	assert.equal(writer.grantCalls(), 1);
});

// --- (b) replay: no double grant, no double payment ----------------------------

test('confirm: replay — the same confirm mints no second window and no second payment', async () => {
	const store = fakeStore();
	const writer = fakeWriter();

	const first = await confirmAndGrant({ store, now: NOW }, RECORD_7D, writer);
	const second = await confirmAndGrant({ store, now: NOW }, RECORD_7D, writer);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(second.grant.created, false, 'a replay must not mint a grant');
	assert.equal(second.grant.subscriptionId, first.grant.subscriptionId, 'one payment_id, one subscription');
	assert.equal(second.grant.bucket, 'frsubs');
	assert.equal(second.paymentAlreadyConfirmed, true, 'the payment was already confirmed on the first pass');
	// The durable store still holds exactly ONE confirmed payment row.
	assert.equal(store.confirmedCount(), 1, 'one payment row, not two');
	assert.equal(writer.grantCalls(), 2, 'grant is delegated twice but only the first created');
});

// --- (c) amount mismatch / unknown plan -> reject before any write -------------

test('confirm: error — an amount mismatch is rejected and never confirms the payment', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const r = await confirmAndGrant(
		{ store, now: NOW },
		{ ...RECORD_7D, amountIdr: 1000 },
		writer
	);

	assert.equal(r.ok, false);
	assert.equal(r.reason, 'amount_mismatch', 'the reason is resolveGrant\'s, not a local copy');
	assert.equal(store.confirmCalls(), 0, 'no write before the rule passes');
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

test('confirm: error — an unknown plan is rejected and never confirms the payment', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const r = await confirmAndGrant(
		{ store, now: NOW },
		{ ...RECORD_7D, plan: 'sub_999d' },
		writer
	);

	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_plan');
	assert.equal(store.confirmCalls(), 0);
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

// --- (d) no payment id -> unknown ----------------------------------------------

test('confirm: unknown — a payment with no internal id is unknown, never a grant', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const r = await confirmAndGrant({ store, now: NOW }, { ...RECORD_7D, id: null }, writer);

	assert.equal(r.ok, false);
	assert.equal(r.reason, 'no_payment_id');
	assert.equal(store.confirmCalls(), 0);
	assert.equal(writer.grantCalls(), 0);
});

test('confirm: unknown — a missing/blank record is unknown', async () => {
	const store = fakeStore();
	const r = await confirmAndGrant({ store, now: NOW }, null, fakeWriter());
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_ref');
});

// --- drizzle store seam --------------------------------------------------------

test('drizzle store: the persist seam is exported for the web route', () => {
	assert.equal(typeof drizzlePaymentConfirmStore, 'function');
});