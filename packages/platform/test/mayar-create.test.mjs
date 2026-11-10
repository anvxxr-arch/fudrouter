// packages/platform/test/mayar-create.test.mjs — the additive Mayar create path.
//
// Why this exists: the Mayar gateway must be an ADDITIVE second path that leaves
// the legacy `qris-native` create untouched (FR-revised B3/M3), and it must
// persist the vendor's create facts onto `payment.raw` so settlement binds on
// OUR write (B1). The invariants pinned here:
//
//   1. with a client: the vendor is called, the row is inserted FIRST (row-first),
//      and `data.id`/`transactionId`/`link` land on `payment.raw.mayar`;
//   2. a retry with the same idempotencyKey returns the same row and the SAME
//      persisted checkout URL, never a second vendor call;
//   3. without a key: the static-QR (legacy) path is used unchanged and the
//      Mayar function is never called.
//
// Everything is in-memory: the gateway store is a fake that mirrors the durable
// UNIQUE (gateway, gateway_ref), and the client is a fake with a counter.
//
// Run: node --test packages/platform/test/mayar-create.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMayarPayment } from '../server/mayar-create.ts';
import { MAYAR_GATEWAY } from '../server/mayar.ts';
import { MAYAR_RAW_KEY, mayarCheckoutUrlOf } from '../server/mayar-settlement.ts';
import { PLANS, qrisFor } from '../server/payments.ts';
import { GATEWAY_DEFAULT, gatewayRefFor } from '../server/gateway.ts';

const PLAN = 'sub_7d';
const AMOUNT = PLANS[PLAN].priceIdr;

/** In-memory store scoped to one gateway, enforcing the (gateway, ref) uniqueness. */
function fakeStore(gateway) {
	const byRef = new Map();
	const rawById = new Map();
	return {
		calls: { updateRaw: 0, updateStatus: 0 },
		async findPayment(ref) {
			const rec = byRef.get(`${gateway}:${ref}`);
			if (!rec) return null;
			return { ...rec, raw: rawById.get(rec.id) };
		},
		async insertPayment(p) {
			const key = `${p.gateway}:${p.gatewayRef}`;
			if (byRef.has(key)) return { ...byRef.get(key), raw: rawById.get(byRef.get(key).id) };
			const record = { ...p, id: `pay_${byRef.size + 1}` };
			byRef.set(key, record);
			return record;
		},
		async updateRaw(id, raw) {
			this.calls.updateRaw += 1;
			rawById.set(id, raw);
		},
		async updateStatus(id, status) {
			this.calls.updateStatus += 1;
			const rec = byRef.get(`${gateway}:${id}`);
			// look up by id across the map
			for (const [k, v] of byRef) {
				if (v.id === id) { byRef.set(k, { ...v, status }); return; }
			}
		}
	};
}

/** A fake Mayar client that counts calls and returns scripted create facts. */
function fakeClient(overrides = {}) {
	const calls = [];
	return {
		calls,
		async createPayment(input) {
			calls.push(input);
			if (overrides.fail) return { ok: false, kind: 'mayar_unavailable', message: 'down' };
			return {
				ok: true,
				value: { id: 'req_1', transactionId: 'tx_1', link: 'https://mayar.test/pl/abc', redirectUrl: null }
			};
		}
	};
}

function ctx(client) {
	return {
		mayarStore: fakeStore(MAYAR_GATEWAY),
		legacyStore: fakeStore(GATEWAY_DEFAULT),
		client
	};
}

const INPUT = { accountId: 'acc_a', channel: 'web', plan: PLAN, amountIdr: AMOUNT, idempotencyKey: 'k1' };

// --- with a client -----------------------------------------------------------

test('create: the vendor is called once and the row is inserted FIRST', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const legacy = fakeStore(GATEWAY_DEFAULT);
	const client = fakeClient();
	const r = await createMayarPayment({ mayarStore: store, legacyStore: legacy, client }, INPUT);

	assert.equal(r.ok, true);
	assert.equal(r.state, 'created');
	assert.equal(r.gatewayRef, gatewayRefFor('k1'));
	assert.equal(r.checkoutUrl, 'https://mayar.test/pl/abc');
	assert.equal(client.calls.length, 1);
	assert.equal(client.calls[0].amount, AMOUNT);
	// The gateway column is 'mayar', not the default.
	assert.equal(r.record.gateway, MAYAR_GATEWAY);
});

test('create: the vendor facts are persisted onto payment.raw.mayar (B1)', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const legacy = fakeStore(GATEWAY_DEFAULT);
	const r = await createMayarPayment(
		{ mayarStore: store, legacyStore: legacy, client: fakeClient() },
		INPUT
	);
	assert.equal(r.ok, true);
	assert.equal(store.calls.updateRaw, 1, 'exactly one raw write');
	const persisted = await store.findPayment(r.gatewayRef);
	assert.deepEqual(persisted.raw[MAYAR_RAW_KEY], {
		id: 'req_1',
		transactionId: 'tx_1',
		link: 'https://mayar.test/pl/abc'
	});
	assert.equal(mayarCheckoutUrlOf(persisted.raw), 'https://mayar.test/pl/abc');
});

test('create: a retry with the same idempotencyKey is row-first and calls the vendor once', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const legacy = fakeStore(GATEWAY_DEFAULT);
	const client = fakeClient();
	const ctxObj = { mayarStore: store, legacyStore: legacy, client };

	const first = await createMayarPayment(ctxObj, INPUT);
	const second = await createMayarPayment(ctxObj, INPUT);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(second.state, 'existing');
	assert.equal(second.record.id, first.record.id, 'one row, not two');
	assert.equal(second.checkoutUrl, first.checkoutUrl, 'the same persisted checkout URL');
	assert.equal(client.calls.length, 1, 'a retry never dials the vendor again');
	assert.equal(store.calls.updateRaw, 1, 'the raw write happens once');
});

test('create: a vendor failure is typed and marks the row failed (not a dead pending)', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const r = await createMayarPayment(
		{ mayarStore: store, legacyStore: fakeStore(GATEWAY_DEFAULT), client: fakeClient({ fail: true }) },
		INPUT
	);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'mayar_unavailable');
	const persisted = await store.findPayment(gatewayRefFor('k1'));
	assert.equal(persisted.status, 'failed', 'a dead vendor create leaves a failed row, not a stuck pending');
	assert.equal(store.calls.updateStatus, 1);
});

test('create: a failed row is re-attempted on retry (not hidden behind existing)', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const legacy = fakeStore(GATEWAY_DEFAULT);
	const client = fakeClient();
	const ctxObj = { mayarStore: store, legacyStore: legacy, client };

	// First attempt: fail -> row marked failed.
	const failing = fakeClient({ fail: true });
	const first = await createMayarPayment({ mayarStore: store, legacyStore: legacy, client: failing }, INPUT);
	assert.equal(first.ok, false);

	// Second attempt with a live client: the SAME row re-dials the vendor.
	const second = await createMayarPayment(ctxObj, INPUT);
	assert.equal(second.ok, true);
	assert.equal(second.state, 'created');
	assert.equal(client.calls.length, 1, 'the retry dials the vendor for the same row');
	assert.equal(failing.calls.length, 1);
	const persisted = await store.findPayment(gatewayRefFor('k1'));
	assert.equal(persisted.status, 'pending', 'the re-attempt leaves the row settleable');
	assert.deepEqual(persisted.raw[MAYAR_RAW_KEY], {
		id: 'req_1',
		transactionId: 'tx_1',
		link: 'https://mayar.test/pl/abc'
	});
});

test('create: an unknown plan / bad amount is refused before the vendor call', async () => {
	const client = fakeClient();
	const bad = await createMayarPayment(ctx(client), { ...INPUT, plan: 'sub_999d' });
	assert.equal(bad.ok, false);
	assert.equal(bad.reason, 'unknown_plan');
	const badAmt = await createMayarPayment(ctx(client), { ...INPUT, amountIdr: 1.5 });
	assert.equal(badAmt.ok, false);
	assert.equal(badAmt.reason, 'invalid_amount');
	assert.equal(client.calls.length, 0);
});

// --- without a client (legacy static QR) --------------------------------------

test('create: without a key the static-QR path runs and Mayar is never called', async () => {
	const store = fakeStore(MAYAR_GATEWAY);
	const legacy = fakeStore(GATEWAY_DEFAULT);
	const client = fakeClient();
	const r = await createMayarPayment({ mayarStore: store, legacyStore: legacy, client: null }, INPUT);

	assert.equal(r.ok, true);
	assert.equal(r.state, 'created');
	assert.equal(r.checkoutUrl, null, 'the legacy path has no checkout URL');
	assert.equal(r.qr, qrisFor(AMOUNT), 'the static QR is byte-identical to the legacy create');
	assert.equal(client.calls.length, 0, 'the Mayar client is never touched');
	assert.equal((await store.findPayment(gatewayRefFor('k1'))), null, 'nothing is written to the mayar-scoped store');
});