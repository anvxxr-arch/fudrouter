// packages/platform/test/add-credit.test.mjs — the four-case contract (criterion 3).
//
// Why this file exists: `validateAddCreditAmount` is the one rule that decides
// whether a manual top-up becomes money. A missed ceiling is exactly how the
// pre-bigint placeholder minted 5.55e18 µUSD on one posting
// (ops/scrub-balance-anomaly.sql §Root cause); a NULL-parse falling back to 0 is
// how a typo becomes a silent zero credit. Both are worse than a crash, so every
// branch is pinned: success, error, warn (rejected, never clamped), and the
// namespace/idempotency identity that frees `purchase:` for the gateway.
//
// Flat top-level tests (no nesting): node:test runs a nested `test()` only if
// the parent awaits it, and a synchronous parent completes first — the subtests
// then report as cancelled. One level, one name per case.
//
// Run: node --test packages/platform/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	MAX_ADD_CREDIT_MICRO,
	ADD_CREDIT_KEY_PREFIX,
	addCreditKey,
	validateAddCreditAmount,
	addCreditError,
	validateAddCreditKey,
	addCreditKeyError
} from '../server/add-credit.ts';
import { parseAmountToMicro } from '../server/money.ts';

// --- parse -------------------------------------------------------------------

test('parse: success — at most six decimal places, never float arithmetic', () => {
	assert.equal(parseAmountToMicro('10'), 10_000_000n);
	assert.equal(parseAmountToMicro('10.50'), 10_500_000n);
	assert.equal(parseAmountToMicro('0.00421'), 4_210n);
	assert.equal(parseAmountToMicro('0.000001'), 1n);
	assert.equal(parseAmountToMicro('-3.25'), -3_250_000n);
	// A bare number (form value) must not throw, matching the old .mjs writer.
	assert.equal(parseAmountToMicro(3.5), 3_500_000n);
});

test('parse: error — a float-precision trap is refused, not silently rounded', () => {
	assert.equal(parseAmountToMicro('1.0000001'), null, '7dp must be refused');
	assert.equal(parseAmountToMicro('abc'), null);
	assert.equal(parseAmountToMicro(''), null);
	assert.equal(parseAmountToMicro(undefined), null);
	assert.equal(parseAmountToMicro('..'), null);
});

// --- validate ----------------------------------------------------------------

test('validate: success — a positive in-range amount parses to its micro value', () => {
	assert.deepEqual(validateAddCreditAmount('100'), { ok: true, amountMicro: 100_000_000n });
	assert.deepEqual(validateAddCreditAmount('25.50'), { ok: true, amountMicro: 25_500_000n });
	// The ceiling itself is inclusive: $1M is the largest legitimate amount.
	assert.deepEqual(validateAddCreditAmount('1000000'), { ok: true, amountMicro: MAX_ADD_CREDIT_MICRO });
});

test('validate: error — a non-positive amount is refused with its own code', () => {
	assert.deepEqual(validateAddCreditAmount('0'), { ok: false, error: 'not_positive' });
	assert.deepEqual(validateAddCreditAmount('-1'), { ok: false, error: 'not_positive' });
	assert.deepEqual(validateAddCreditAmount('0.00'), { ok: false, error: 'not_positive' });
	// A NULL parse must be a rejection, never a default 0.
	assert.deepEqual(validateAddCreditAmount('nope'), { ok: false, error: 'invalid_amount' });
	assert.deepEqual(validateAddCreditAmount(''), { ok: false, error: 'invalid_amount' });
	assert.deepEqual(validateAddCreditAmount(undefined), { ok: false, error: 'invalid_amount' });
});

test('validate: warn — an over-ceiling amount is rejected, never clamped', () => {
	const over = validateAddCreditAmount('1000000.01');
	assert.equal(over.ok, false);
	assert.equal(over.ok === false && over.error, 'ceiling_exceeded');
	// The code carries a machine-readable name and a human message.
	assert.equal(addCreditError('ceiling_exceeded').code, 'ADD_CREDIT_CEILING_EXCEEDED');
	// One micro-unit above the ceiling is already a rejection.
	assert.equal(validateAddCreditAmount((MAX_ADD_CREDIT_MICRO + 1n).toString()).ok, false);
});

// --- namespace/idempotency ----------------------------------------------------

test('namespace: success — manual top-ups use admin_credit:, freeing purchase: for the gateway', () => {
	assert.equal(ADD_CREDIT_KEY_PREFIX, 'admin_credit:');
	assert.equal(addCreditKey('txn_abc123'), 'admin_credit:txn_abc123');
	// The ceiling is the shared scrub threshold, not a second inline literal.
	assert.equal(MAX_ADD_CREDIT_MICRO, 1_000_000_000_000n);
});

test('key: success — admin_credit: and other neutral keys are accepted', () => {
	assert.deepEqual(validateAddCreditKey('admin_credit:txn_abc'), { ok: true, key: 'admin_credit:txn_abc' });
	assert.deepEqual(validateAddCreditKey('txn_abc'), { ok: true, key: 'txn_abc' });
});

test('key: warn — a client-supplied reserved namespace is refused, not silently absorbed', () => {
	// purchase: (gateway) and usage: (meter) are the two reserved namespaces; a
	// caller claiming them must be rejected rather than let the durable unique
	// index silently drop a real posting later.
	assert.deepEqual(validateAddCreditKey('purchase:ref-1'), { ok: false, error: 'reserved_namespace' });
	assert.deepEqual(validateAddCreditKey('usage:req_1'), { ok: false, error: 'reserved_namespace' });
	assert.equal(addCreditKeyError('reserved_namespace').code, 'ADD_CREDIT_RESERVED_KEY');
});

// --- source scan --------------------------------------------------------------

test('no legacy purchase: namespace survives in the writers', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(here, '..', '..', '..');
	const files = [
		'apps/web/server/pages.mjs',
		'apps/web/server/admin.mjs'
	];
	for (const rel of files) {
		// Only assert the reserved namespace is gone from the writer files.
		assert.ok(!readFileSync(join(repoRoot, rel), 'utf8').includes('purchase:'), `${rel} must not mint purchase: idempotency keys`);
	}
});