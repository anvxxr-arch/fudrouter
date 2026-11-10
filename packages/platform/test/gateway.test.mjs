// packages/platform/test/gateway.test.mjs — the gateway interface contract.
//
// Why this file exists: the interface decides where money becomes service, which
// is the part that must not drift after a vendor adapter lands (ADR-0008). Four
// invariants are pinned before any vendor is chosen:
//
//   1. a replayed callback is never a second grant (idempotent create + replay);
//   2. an amount mismatch is refused by `resolveGrant`, not guessed;
//   3. an unknown plan is refused before any amount check;
//   4. a callback with a missing ref is "unknown", never a grant.
//
// Everything here is in-memory: the stores are fakes, the clock is frozen where
// needed, and the grant rule every surface shares is `grantForPayment` →
// `resolveGrant` from payments.ts (criterion 2). The gateway module owns create
// and callback verification; the confirm→grant loop itself lives in
// payment-confirm.ts (B3b) and is covered by payment-confirm.test.mjs, so this
// file pins only the interface contract: idempotent create, HMAC verify, replay
// refusal and the "unknown ref" case.
//
// Flat top-level tests (no nesting): node:test only runs a nested `test()` when
// the parent awaits it, and a synchronous parent completes first.
//
// Run: node --test packages/platform/test/gateway.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	GATEWAY_SIGNATURE_HEADER,
	GATEWAY_SETTLED_CODE,
	gatewayRefFor,
	createPayment,
	parseCallback,
	signCallback,
	verifyCallback,
	nonceFresh
} from '../server/gateway.ts';
import { PLANS, qrisFor } from '../server/payments.ts';

const SECRET = 'top-secret-gateway-key';
const NOW = new Date('2026-11-09T12:00:00Z');

/** In-memory payment store: the UNIQUE (gateway, gateway_ref) is enforced here. */
function fakeStore() {
	const byRef = new Map();
	return {
		findPayment: async (gatewayRef) => byRef.get(gatewayRef) ?? null,
		insertPayment: async (payment) => {
			// Assert the single-writer invariant: a ref already owned is returned,
			// not overwritten — the store is the durable unique index's stand-in.
			if (byRef.has(payment.gatewayRef)) return byRef.get(payment.gatewayRef);
			const record = { ...payment, id: `pay_${byRef.size + 1}` };
			byRef.set(payment.gatewayRef, record);
			return record;
		}
	};
}

/** In-memory nonce store: first sighting wins, hence "no double grant". */
function fakeNonces() {
	const seen = new Set();
	return {
		claim: async (nonce) => {
			if (seen.has(nonce)) return false;
			seen.add(nonce);
			return true;
		}
	};
}

function verifyCtx(overrides = {}) {
	return {
		secret: SECRET,
		nonces: fakeNonces(),
		now: NOW,
		...overrides
	};
}

const SUB_7D = { accountId: 'acc_alice', channel: 'web', plan: 'sub_7d', amountIdr: PLANS.sub_7d.priceIdr };

// --- idempotent create ------------------------------------------------------

test('create: success — a retry with the same idempotencyKey reuses the row', async () => {
	const store = fakeStore();
	const ctx = { store };
	const input = { ...SUB_7D, idempotencyKey: 'alice-7d-1' };

	const first = await createPayment(ctx, input);
	const second = await createPayment(ctx, input);

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.state, 'created');
	assert.equal(second.state, 'existing', 'a retry must not mint a duplicate');
	assert.equal(first.gatewayRef, second.gatewayRef);
	assert.equal(first.record.id, second.record.id, 'one payment row, not two');
	assert.equal(first.gatewayRef, gatewayRefFor('alice-7d-1'));
	assert.equal(first.gatewayRef, 'purchase:alice-7d-1');
});

test('create: error — an unknown plan is refused before QR/amount work', async () => {
	const r = await createPayment({ store: fakeStore() }, { ...SUB_7D, plan: 'sub_999d', idempotencyKey: 'x' });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'unknown_plan');
});

test('create: warn — a missing idempotencyKey is refused, not defaulted', async () => {
	const r = await createPayment({ store: fakeStore() }, { ...SUB_7D, idempotencyKey: '' });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'missing_idempotency_key');
});

test('create: retry divergence — a DIFFERENT amount must not mint a different QR', async () => {
	// An idempotencyKey owns ONE payment intent. A retry that changes the
	// amount must still reproduce the FIRST intent's payload: the returned `qr`
	// has to match the stored record's amount, or the member pays a different
	// amount than the settlement will verify against (resolveGrant).
	const store = fakeStore();
	const ctx = { store };

	const first = await createPayment(ctx, { ...SUB_7D, idempotencyKey: 'alice-divergence' });
	const retry = await createPayment(ctx, { ...SUB_7D, amountIdr: 1000, idempotencyKey: 'alice-divergence' });

	assert.equal(first.ok, true);
	assert.equal(retry.ok, true);
	assert.equal(retry.state, 'existing');
	// The record is the FIRST intent's row (never overwritten)…
	assert.equal(retry.record.amountIdr, first.record.amountIdr);
	// …and the QR it shows must encode that stored amount, not the retry's 1000.
	assert.equal(retry.qr, qrisFor(first.record.amountIdr));
});

// --- callback verify + replay ----------------------------------------------

test('verify: success — a valid signed callback verifies once', async () => {
	const store = fakeStore();
	const { gatewayRef } = await createPayment({ store }, { ...SUB_7D, idempotencyKey: 'alice-7d-2' });

	const body = JSON.stringify({ code: 'OK', amount: PLANS.sub_7d.priceIdr, ref: gatewayRef, nonce: 'n1', timestamp: NOW.getTime() });
	const headers = { [GATEWAY_SIGNATURE_HEADER]: signCallback(body, SECRET) };
	const r = await verifyCallback(verifyCtx(), body, headers);

	assert.equal(r.ok, true);
	assert.equal(r.gatewayRef, gatewayRef);
	assert.equal(r.amountIdr, PLANS.sub_7d.priceIdr);
});

test('verify: error — a replayed callback is refused (no double grant)', async () => {
	const store = fakeStore();
	const { gatewayRef } = await createPayment({ store }, { ...SUB_7D, idempotencyKey: 'alice-7d-3' });

	const body = JSON.stringify({ code: 'OK', amount: PLANS.sub_7d.priceIdr, ref: gatewayRef, nonce: 'same-nonce', timestamp: NOW.getTime() });
	const headers = { [GATEWAY_SIGNATURE_HEADER]: signCallback(body, SECRET) };
	const ctx = verifyCtx();

	const first = await verifyCallback(ctx, body, headers);
	const second = await verifyCallback(ctx, body, headers);

	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	assert.equal(second.reason, 'replay', 'the second delivery of the same nonce must be refused');
});

test('verify: warn — an unsigned or forged body is refused before any nonce', async () => {
	const store = fakeStore();
	const { gatewayRef } = await createPayment({ store }, { ...SUB_7D, idempotencyKey: 'alice-7d-4' });
	const body = JSON.stringify({ code: 'OK', amount: PLANS.sub_7d.priceIdr, ref: gatewayRef, nonce: 'n2', timestamp: NOW.getTime() });

	const forged = await verifyCallback(verifyCtx(), body, { [GATEWAY_SIGNATURE_HEADER]: 'sha256=deadbeef' });
	assert.equal(forged.ok, false);
	assert.equal(forged.reason, 'bad_signature');

	const missing = await verifyCallback(verifyCtx(), body, {});
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, 'bad_signature');
});

test('verify: error — a stale timestamp is refused outside the window', async () => {
	assert.equal(nonceFresh(NOW.getTime(), NOW.getTime() + 10 * 60 * 1000, 5 * 60 * 1000), false);
	assert.equal(nonceFresh(NOW.getTime(), NOW.getTime() + 4 * 60 * 1000, 5 * 60 * 1000), true);
});

test('verify: error — a non-OK settlement code is refused', async () => {
	const store = fakeStore();
	const { gatewayRef } = await createPayment({ store }, { ...SUB_7D, idempotencyKey: 'alice-7d-5' });
	const body = JSON.stringify({ code: 'PENDING', amount: PLANS.sub_7d.priceIdr, ref: gatewayRef, nonce: 'n3', timestamp: NOW.getTime() });
	const r = await verifyCallback(verifyCtx(), body, { [GATEWAY_SIGNATURE_HEADER]: signCallback(body, SECRET) });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not_settled');
});

// --- callback parse (unknown case) -------------------------------------------

test('parse: unknown — a body without a ref is "missing_ref", never a default', async () => {
	const body = JSON.stringify({ code: 'OK', amount: 30000, nonce: 'n4', timestamp: NOW.getTime() });
	const r = await verifyCallback(verifyCtx(), body, { [GATEWAY_SIGNATURE_HEADER]: signCallback(body, SECRET) });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'missing_ref');
});

test('parse: success — the default vendor vocabulary maps amount/ref/code', () => {
	const p = parseCallback(JSON.stringify({ code: 'OK', amount: 30000, ref: 'purchase:x', nonce: 'n', timestamp: 1 }));
	assert.equal(p.ok, true);
	assert.equal(p.callback.code, 'OK');
	assert.equal(p.callback.amount, 30000);
	assert.equal(GATEWAY_SETTLED_CODE, 'OK');
});