// packages/platform/test/mayar-settlement.test.mjs — the Mayar settlement rule.
//
// Why this exists: the webhook is a HINT ONLY. The money decision is re-derived
// from the authoritative `GET /transactions/{id}` re-fetch, bound to what WE
// persisted at create (`payment.raw.mayar.transactionId`), gated on
// `status === 'paid'` AND `amount === amount_idr`. The five acceptance cases
// pinned here are the ones a wrong settlement must never break:
//
//   (a) paid + amount match + id match  -> grant exactly once;
//   (b) unpaid                            -> NO grant;
//   (c) amount mismatch                   -> NO grant;
//   (d) replay (same settlement twice)    -> still one grant;
//   (e) fake id (transaction not found)   -> NO grant.
//
// Everything is in-memory: the getter, resolver, confirm store and writer are
// fakes. `confirmAndGrant` itself is the REAL module — its grant is persisted
// through an in-memory subscription writer with the 0038 idempotency contract.
//
// Run: node --test packages/platform/test/mayar-settlement.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMayarSettlement, reconcileMayarPayments, settlementVerdict, mayarTransactionIdOf } from '../server/mayar-settlement.ts';
import { PLANS } from '../server/payments.ts';

const AMOUNT = PLANS.sub_7d.priceIdr;
const TX_ID = 'tx_persisted';

const FACTS = {
	id: 'pay_1',
	gatewayRef: 'purchase:alice-mayar',
	gateway: 'mayar',
	accountId: 'acc_alice',
	channel: 'web',
	plan: 'sub_7d',
	amountIdr: AMOUNT,
	transactionId: TX_ID
};

/** In-memory confirm store mirroring drizzlePaymentConfirmStore idempotency. */
function fakeStore() {
	const rows = new Map();
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
			if (byPayment.has(args.paymentId)) return { id: byPayment.get(args.paymentId), created: false };
			const id = `sub_${byPayment.size + 1}`;
			byPayment.set(args.paymentId, id);
			return { id, created: true };
		}
	};
}

/** A getTransaction seam returning one scripted transaction. */
function getter(tx) {
	return async () => {
		if (tx === null) return { ok: false, kind: 'mayar_rejected', status: 404, message: 'not found' };
		return { ok: true, value: tx };
	};
}

/** A resolver keyed on the persisted transaction id (what settlement passes). */
function resolver(facts) {
	return async (transactionId) => (transactionId === facts.transactionId ? facts : null);
}

function deps(facts, tx) {
	return { getTransaction: getter(tx), findPendingByTransactionId: resolver(facts), store: fakeStore(), writer: fakeWriter() };
}

function paidTx(overrides = {}) {
	return { id: TX_ID, status: 'paid', amount: AMOUNT, ...overrides };
}

// --- (a) success -------------------------------------------------------------

test('settle: paid + amount match + id match grants exactly once', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const d = {
		getTransaction: getter(paidTx()),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const r = await runMayarSettlement(d, TX_ID);

	assert.equal(r.ok, true);
	assert.equal(r.granted, true);
	assert.equal(r.paymentId, 'pay_1');
	assert.equal(store.confirmedCount(), 1);
	assert.equal(writer.grantCalls(), 1);
});

// --- (b) unpaid ---------------------------------------------------------------

test('settle: an unpaid transaction is ACKed and never grants', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const d = {
		getTransaction: getter(paidTx({ status: 'unpaid' })),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const r = await runMayarSettlement(d, TX_ID);
	assert.equal(r.ok, false);
	assert.equal(r.ack, true);
	assert.equal(r.reason, 'not_paid');
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

// --- (c) amount mismatch ------------------------------------------------------

test('settle: an amount mismatch is ACKed and never grants', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const d = {
		getTransaction: getter(paidTx({ amount: AMOUNT - 1000 })),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const r = await runMayarSettlement(d, TX_ID);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'amount_mismatch');
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

// --- (d) replay ---------------------------------------------------------------

test('settle: a replay is one grant, never two', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const d = {
		getTransaction: getter(paidTx()),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const first = await runMayarSettlement(d, TX_ID);
	const second = await runMayarSettlement(d, TX_ID);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true, 'a replay of an already-confirmed payment is a normal idempotent case');
	assert.equal(second.granted, false);
	assert.equal(second.alreadyConfirmed, true);
	assert.equal(second.subscriptionId, first.subscriptionId);
	assert.equal(store.confirmedCount(), 1, 'one confirmed payment row');
	assert.equal(writer.grantCalls(), 2, 'confirmAndGrant is delegated twice but only the first created');
});

// --- (e) fake id --------------------------------------------------------------

test('settle: a transaction not found (fake id) is ACKed and never grants', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const d = {
		getTransaction: getter(null),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const r = await runMayarSettlement(d, 'totally_fake_id');
	assert.equal(r.ok, false);
	assert.equal(r.ack, true);
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

// --- reconcile sweep (H4) ------------------------------------------------------

test('reconcile: a paid-yet-ungranted transaction grants exactly once', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const tx = paidTx();
	const listTxs = async () => ({
		ok: true,
		value: { items: [tx], hasMore: false, nextStartingAfter: null }
	});
	const d = {
		getTransaction: getter(tx),
		listTransactions: listTxs,
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};

	const first = await reconcileMayarPayments(d, { maxPages: 5 });
	assert.equal(first.granted, 1);
	assert.equal(store.confirmedCount(), 1);
	assert.equal(writer.grantCalls(), 1);

	// A second reconcile is a no-op: the row is now confirmed, so the pending
	// resolver returns null and the vendor facts are not re-granted.
	const second = await reconcileMayarPayments(d, { maxPages: 5 });
	assert.equal(second.granted, 0);
	assert.equal(store.confirmedCount(), 1, 'still one confirmed payment');
});

test('reconcile: an await-pending (non-paid) transaction is never granted', async () => {
	const store = fakeStore();
	const writer = fakeWriter();
	const tx = paidTx({ status: 'unpaid' });
	const d = {
		getTransaction: getter(tx),
		listTransactions: async () => ({ ok: true, value: { items: [tx], hasMore: false, nextStartingAfter: null } }),
		findPendingByTransactionId: resolver(FACTS),
		store,
		writer
	};
	const r = await reconcileMayarPayments(d, { maxPages: 5 });
	assert.equal(r.granted, 0);
	assert.equal(store.confirmedCount(), 0);
	assert.equal(writer.grantCalls(), 0);
});

// --- pure verdict helpers -----------------------------------------------------

test('settle: a fetched id that differs from our persisted id is raw_id_mismatch', () => {
	const v = settlementVerdict(paidTx({ id: 'other_tx' }), FACTS);
	assert.equal(v.ok, false);
	assert.equal(v.reason, 'raw_id_mismatch');
});

test('settle: a row with no persisted transaction id is refused, never guessed', () => {
	const v = settlementVerdict(paidTx(), { ...FACTS, transactionId: null });
	assert.equal(v.ok, false);
	assert.equal(v.reason, 'no_transaction_id');
});

test('mayarTransactionIdOf reads the raw jsonb (object or string)', () => {
	assert.equal(mayarTransactionIdOf({ mayar: { transactionId: 'tx_9' } }), 'tx_9');
	assert.equal(mayarTransactionIdOf(JSON.stringify({ mayar: { transactionId: 'tx_9' } })), 'tx_9');
	assert.equal(mayarTransactionIdOf(null), null);
	assert.equal(mayarTransactionIdOf({ other: true }), null);
});