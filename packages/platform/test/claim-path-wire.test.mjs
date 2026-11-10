// packages/platform/test/claim-path-wire.test.mjs — T9 smoke: the shared claim
// path, end to end (BE B, sprint-1).
//
// Why this file exists: `drizzleClaimWriter` (packages/platform/server/claim.ts)
// is the ONE durable claim write that every real claim path shares — the web
// checkout (apps/web/server/pages.mjs POST /api/pages/subscription/claim) and
// the Telegram / Discord bot transports (recordClaim/resolveClaim wired through
// the platform-ts bridge to this writer). This test proves that WRITER enforces
// the money-safe contract each surface inherits, against a stateful in-memory
// `DbTx` stand-in mirroring the real drizzle `update…returning` /
// `select…limit 1` chains (no DATABASE_URL):
//
//   1. claim from a PENDING payment  -> { ok: true }, status 'claimed', one write;
//   2. replay (same payment id)      -> { ok: false, reason: 'already_claimed' },
//                                       no second write, no downgrade;
//   3. resolve the payment id        -> the full PaymentConfirmRecord;
//   4. claim AFTER a confirm         -> 'already_claimed' AND status stays
//                                       'confirmed' (never downgraded).
//
// Run: node --test packages/platform/test/claim-path-wire.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drizzleClaimWriter } from '../server/claim.ts';

const PROOF = 'https://cdn.example/proof.png';

/**
 * A stateful `DbTx` stand-in. The real writer builds two chains:
 *
 *   - `update(payment).set({status:'claimed', raw, updatedAt})
 *        .where(sql`${payment.id} = ${paymentId} and ${payment.status} =
 *        'pending'`).returning({id})` — the durable CAS;
 *   - `select({status}).from(payment).where(eq(payment.id, paymentId)).limit(1)`
 *        — the "already_claimed vs not_found" disambiguation;
 *   - `select({id, accountId, channel, gatewayRef, gateway, plan, amountIdr,
 *        raw}).from(payment).where(eq(payment.id, paymentId)).limit(1)` —
 *        the resolve fa read.
 *
 * drizzle's `sql`/`eq` template params land in `cond.queryChunks`; a bound
 * string param is `chunks[3]` for the CAS and a `{ value }` param for `eq`.
 */
function extractPaymentId(cond) {
	const chunks = cond?.queryChunks;
	if (!Array.isArray(chunks) || chunks.length < 4) return undefined;
	const p = chunks[3];
	if (typeof p === 'string') return p;
	if (p && typeof p === 'object' && 'value' in p) return String(p.value);
	return undefined;
}

function fakeDb(rows) {
	const db = {
		update() {
			const b = {
				set: null,
				set(v) {
					b.set = v;
					return b;
				},
				where(cond) {
					b.cond = cond;
					return b;
				},
				returning() {
					return b;
				},
				then(res, rej) {
					try {
						const paymentId = extractPaymentId(b.cond);
						const row = rows.get(paymentId);
						// CAS: only a 'pending' row flips; a claimed/confirmed row
						// matches nothing, mirroring `status = 'pending'`.
						if (row && row.status === 'pending') {
							row.status = b.set.status;
							row.raw = b.set.raw;
							row.updatedAt = b.set.updatedAt;
							res([{ id: paymentId }]);
						} else {
							res([]);
						}
					} catch (e) {
						rej(e);
					}
				}
			};
			return b;
		},
		select() {
			const b = {
				where(cond) {
					b.cond = cond;
					return b;
				},
				from() {
					return b;
				},
				limit() {
					return b;
				},
				then(res, rej) {
					try {
						const paymentId = extractPaymentId(b.cond);
						const row = rows.get(paymentId);
						res(row ? [row] : []);
					} catch (e) {
						rej(e);
					}
				}
			};
			return b;
		}
	};
	return db;
}

/** Seed one `payment` row (matching the schema columns) and return the db. */
function seedRow(rows, overrides = {}) {
	const row = {
		id: 'pay_1',
		accountId: 'acc_1',
		channel: 'web',
		gatewayRef: 'gateway_ref_1',
		gateway: 'qris-native',
		plan: 'sub_7d',
		amountIdr: 30000,
		status: 'pending',
		raw: undefined,
		...overrides
	};
	rows.set(row.id, row);
	return row;
}

test('claim-path: web checkout records a pending payment → claimed, one write', async () => {
	const rows = new Map();
	const row = seedRow(rows);
	const writer = drizzleClaimWriter(fakeDb(rows));

	const result = await writer.record('pay_1', PROOF);

	assert.deepEqual(result, { ok: true });
	assert.equal(row.status, 'claimed', 'CAS flips pending -> claimed');
	assert.deepEqual(row.raw, { proofUrl: PROOF }, 'raw mirrors the web checkout jsonb shape');
	assert.ok(row.updatedAt instanceof Date, 'updated_at refreshed to now');
});

test('claim-path: replay returns already_claimed and mints no second write', async () => {
	const rows = new Map();
	const row = seedRow(rows);
	const writer = drizzleClaimWriter(fakeDb(rows));

	assert.deepEqual(await writer.record('pay_1', PROOF), { ok: true });
	const replayed = await writer.record('pay_1', PROOF);

	assert.deepEqual(replayed, { ok: false, reason: 'already_claimed' });
	assert.equal(row.status, 'claimed', 'still claimed, never a second flip');
});

test('claim-path: resolve returns the full PaymentConfirmRecord', async () => {
	const rows = new Map();
	seedRow(rows, { status: 'confirmed' });
	const writer = drizzleClaimWriter(fakeDb(rows));

	const resolved = await writer.resolve('pay_1');

	assert.equal(resolved.id, 'pay_1');
	assert.equal(resolved.accountId, 'acc_1');
	assert.equal(resolved.channel, 'web');
	assert.equal(resolved.gatewayRef, 'gateway_ref_1');
	assert.equal(resolved.gateway, 'qris-native');
	assert.equal(resolved.plan, 'sub_7d');
	assert.equal(resolved.amountIdr, 30000, 'bigint amount maps to whole rupiah');
});

test('claim-path: a claim after confirm never downgrades confirmed → claimed', async () => {
	const rows = new Map();
	const row = seedRow(rows, { status: 'confirmed', raw: { settlement: true } });
	const writer = drizzleClaimWriter(fakeDb(rows));

	const result = await writer.record('pay_1', PROOF);

	assert.deepEqual(result, { ok: false, reason: 'already_claimed' });
	assert.equal(row.status, 'confirmed', 'confirmed is never overwritten by a claim');
	assert.deepEqual(row.raw, { settlement: true }, 'the confirmed raw is untouched');
});