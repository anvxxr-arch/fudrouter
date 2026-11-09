// packages/platform/test/claim.test.mjs — the durable claim writer (CS1).
//
// Why this file exists: `drizzleClaimWriter` is the ONE write a member's proof
// upload performs (pending → claimed). The four cases pin the money-safe,
// idempotent contract that both bot transports must inherit:
//
//   1. pending → claimed        -> { ok: true }, single flip;
//   2. replay (already claimed) -> { ok: false, reason: 'already_claimed' },
//                                  never a double write, never a downgrade;
//   3. resolve missing          -> null;
//   4. resolve hit              -> the full PaymentConfirmRecord, amount mapped
//                                  from bigint to whole-rupiah number.
//
// The fake below stands in for the drizzle `DbTx` handle: it wires the two
// builder chains the writer uses (`update…returning`, `select…limit 1`) without
// a network or DATABASE_URL. The real Postgres handle is supplied by the web
// transports; the decision and idempotency are what this file pins.
//
// Run: node --test packages/platform/test/claim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drizzleClaimWriter } from '../server/claim.ts';

const PROOF = 'https://cdn.example/proof.png';

/**
 * In-memory `DbTx` stand-in. `update` and `select` return thenable builders whose
 * `.where/.set/.returning/.from/.limit` chain back to `this` (mirroring drizzle)
 * and resolve to the programmed result on `await`. `update` captures the `.set`
 * payload so the test asserts the exact status/raw/updatedAt write.
 */
function fakeDb(program) {
	function updateBuilder(run) {
		const b = {
			set: null,
			set(v) {
				b.set = v;
				return b;
			},
			where() {
				return b;
			},
			returning() {
				return b;
			},
			then(res, rej) {
				try {
					res(run(b));
				} catch (e) {
					rej(e);
				}
			}
		};
		return b;
	}
	function selectBuilder(run) {
		const b = {
			from() {
				return b;
			},
			where() {
				return b;
			},
			limit() {
				return b;
			},
			then(res, rej) {
				try {
					res(run());
				} catch (e) {
					rej(e);
				}
			}
		};
		return b;
	}
	return {
		update: () => updateBuilder(program.update),
		select: () => selectBuilder(() => program.select())
	};
}

const FULL_ROW = {
	id: 'pay_1',
	accountId: 'acc_1',
	channel: 'telegram',
	gatewayRef: 'purchase:tg:acc_1:42',
	gateway: 'qris-native',
	plan: 'sub_7d',
	amountIdr: 30000n, // bigint, as Postgres returns it
	raw: { proofUrl: PROOF }
};

// --- (a) pending → claimed ----------------------------------------------------

test('claim: record — pending flips to claimed exactly once', async () => {
	let set = null;
	let updateCalls = 0;
	const db = fakeDb({
		update: (b) => {
			updateCalls += 1;
			set = b.set;
			return [{ id: 'pay_1' }]; // the `returning` row: one flip happened
		},
		select: () => []
	});
	const writer = drizzleClaimWriter(db);

	const result = await writer.record('pay_1', PROOF);

	assert.deepEqual(result, { ok: true });
	assert.equal(updateCalls, 1, 'one write, not a find-then-write double');
	assert.equal(set.status, 'claimed');
	assert.deepEqual(set.raw, { proofUrl: PROOF });
	assert.ok(set.updatedAt instanceof Date, 'updated_at is refreshed to now');
});

// --- (b) replay → already_claimed (no double) ---------------------------------

test('claim: record — a replay returns already_claimed and mints nothing', async () => {
	const db = fakeDb({
		update: () => [], // no row flipped: it already left 'pending'
		select: () => [{ status: 'claimed' }]
	});
	const writer = drizzleClaimWriter(db);

	const result = await writer.record('pay_1', PROOF);

	assert.deepEqual(result, { ok: false, reason: 'already_claimed' });
});

// --- (c) resolve missing → null -----------------------------------------------

test('claim: resolve — a missing payment resolves to null', async () => {
	const db = fakeDb({ update: () => [], select: () => [] });
	const writer = drizzleClaimWriter(db);

	const result = await writer.resolve('pay_missing');

	assert.equal(result, null);
});

// --- (d) resolve hit → correct record -----------------------------------------

test('claim: resolve — a hit returns the full PaymentConfirmRecord with bigint amount mapped', async () => {
	const db = fakeDb({ update: () => [], select: () => [FULL_ROW] });
	const writer = drizzleClaimWriter(db);

	const result = await writer.resolve('pay_1');

	assert.equal(result.id, 'pay_1');
	assert.equal(result.accountId, 'acc_1');
	assert.equal(result.channel, 'telegram');
	assert.equal(result.gatewayRef, 'purchase:tg:acc_1:42');
	assert.equal(result.gateway, 'qris-native');
	assert.equal(result.plan, 'sub_7d');
	assert.equal(result.amountIdr, 30000, 'amount_idr bigint maps to a whole-rupiah number');
	assert.deepEqual(result.raw, { proofUrl: PROOF });
});