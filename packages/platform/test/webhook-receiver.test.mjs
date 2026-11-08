// packages/platform/test/webhook-receiver.test.mjs — the inbound gateway
// callback receiver (B3a).
//
// Why this file exists: the receiver is the TRANSPORT half of the inbound
// settlement callback, and its four order-of-operations guarantees must hold
// before any vendor adapter lands (ADR-0008 criterion #4):
//
//   1. a valid signed callback verifies and claims once (success);
//   2. a forged/unsigned body is refused BEFORE any nonce work (error);
//   3. a replayed nonce or an already-seen ref is refused (replay/idempotency);
//   4. a malformed body is an "unknown"/reject, never a grant.
//
// Everything is in-memory: the secret is a plain-String S0 envelope (a JSON
// string `{"secret":…}`, encrypted through credentials.ts), the nonce/delivery
// stores are fakes, and the clock is frozen. No database is touched, so the
// test runs against the pure module only.
//
// Flat top-level tests (no nesting): node:test only runs a nested `test()` when
// the parent awaits it, and a synchronous parent completes first.
//
// Run: node --test packages/platform/test/webhook-receiver.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptCredentials } from '../server/credentials.ts';
import {
	INBOUND_SIGNATURE_HEADER,
	verifyInbound,
	signInbound,
	claimDelivery,
	assertInboundPublic,
	httpStatusForReject
} from '../server/webhook-receiver.ts';
import { GATEWAY_SETTLED_CODE } from '../server/gateway.ts';

const SECRET = 'top-secret-gateway-key';
// The S0 envelope is keyed by CREDENTIALS_MASTER_KEY (base64 of 32 bytes); set
// it before the top-level encryptCredentials call, exactly as the real envelope
// test (apps/web/server/lib/platform-ts.test.mjs) does.
process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
// The shared secret in its S0 envelope: the plaintext is an account JSON whose
// `secret` field is the HMAC key (the same case webhooks.ts signBody reads).
const SECRET_ENC = encryptCredentials({ secret: SECRET });
const NOW = new Date('2026-11-09T12:00:00Z');
const REF = 'purchase:alice-7d-1';

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

/** In-memory delivery store: the payment.gateway_ref UNIQUE (0025) stand-in. */
function fakeDelivery(refs = []) {
	const seen = new Set(refs);
	return { seen: async (gatewayRef) => seen.has(gatewayRef) };
}

function verifyCtx(overrides = {}) {
	return { secretEnc: SECRET_ENC, now: NOW, ...overrides };
}

/** A settled, in-window callback body (the default vendor vocabulary). */
function settledBody(overrides = {}) {
	return JSON.stringify({
		code: GATEWAY_SETTLED_CODE,
		amount: 30000,
		ref: REF,
		nonce: 'nonce-abc',
		timestamp: NOW.getTime(),
		...overrides
	});
}

function signedHeaders(body, secretEnc = SECRET_ENC) {
	return { [INBOUND_SIGNATURE_HEADER]: signInbound(body, secretEnc) };
}

// --- success -----------------------------------------------------------------

test('verify: success — a valid signed callback verifies', async () => {
	const body = settledBody();
	const r = await verifyInbound(verifyCtx(), body, signedHeaders(body));

	assert.equal(r.ok, true);
	assert.equal(r.gatewayRef, REF);
	assert.equal(r.nonce, 'nonce-abc');
	assert.equal(r.amountIdr, 30000);
	assert.equal(r.verifyUrl, null, 'no verify_url means no outbound guard');
});

test('claim: success — a first sighting claims the delivery', async () => {
	const r = await claimDelivery(
		{ nonces: fakeNonces(), delivery: fakeDelivery() },
		REF,
		'nonce-abc',
		5 * 60 * 1000
	);
	assert.equal(r.ok, true);
	assert.equal(r.state, 'claimed');
});

// --- error (signature) -------------------------------------------------------

test('verify: error — a forged signature is refused before any nonce', async () => {
	const body = settledBody();
	const r = await verifyInbound(verifyCtx(), body, {
		[INBOUND_SIGNATURE_HEADER]: 'sha256=deadbeef'
	});
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'bad_signature');
	assert.equal(httpStatusForReject(r.reason), 401, 'a forged body is a 401');

	// Missing signature fails closed.
	const missing = await verifyInbound(verifyCtx(), body, {});
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, 'bad_signature');
});

test('verify: error — a wrong secret fails closed', async () => {
	const body = settledBody();
	const other = encryptCredentials({ secret: 'different-secret' });
	const r = await verifyInbound(verifyCtx(), body, signedHeaders(body, other));
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'bad_signature');
});

// --- replay / idempotency ----------------------------------------------------

test('claim: replay — a replayed nonce is refused (no double grant)', async () => {
	const nonces = fakeNonces();
	const delivery = fakeDelivery();
	const ctx = { nonces, delivery };

	const first = await claimDelivery(ctx, REF, 'same-nonce', 5 * 60 * 1000);
	const second = await claimDelivery(ctx, REF, 'same-nonce', 5 * 60 * 1000);

	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	assert.equal(second.reason, 'replay', 'the second delivery of the same nonce must be refused');
});

test('claim: idempotent — an already-recorded gatewayRef returns existing', async () => {
	const delivery = fakeDelivery([REF]);
	const r = await claimDelivery(
		{ nonces: fakeNonces(), delivery },
		REF,
		'new-nonce',
		5 * 60 * 1000
	);
	assert.equal(r.ok, true);
	assert.equal(r.state, 'existing', 'a re-delivery of a granted ref mints nothing');
});

test('verify: stale — a timestamp outside the window is refused', async () => {
	const body = settledBody({ timestamp: NOW.getTime() - 11 * 60 * 1000 });
	const r = await verifyInbound(verifyCtx(), body, signedHeaders(body));
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'stale_timestamp');
});

// --- malformed / unknown -----------------------------------------------------

test('verify: unknown — a malformed body is rejected, never granted', async () => {
	const r = await verifyInbound(verifyCtx(), 'not-json{', signedHeaders('not-json{'));
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'bad_body');
});

test('verify: unknown — a body without a ref is missing_ref', async () => {
	const body = JSON.stringify({ code: GATEWAY_SETTLED_CODE, amount: 30000, nonce: 'n', timestamp: NOW.getTime() });
	const r = await verifyInbound(verifyCtx(), body, signedHeaders(body));
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'missing_ref');
});

test('verify: not_settled — a non-OK code is refused, status ACKs (200)', async () => {
	const body = settledBody({ code: 'PENDING' });
	const r = await verifyInbound(verifyCtx(), body, signedHeaders(body));
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not_settled');
	assert.equal(httpStatusForReject(r.reason), 200, 'a genuine non-settled body is ACKed');
});

// --- assertInboundPublic ------------------------------------------------------

test('guard: success — a public verify_url passes the injected SSRF guard', async () => {
	const called = [];
	const ctx = {
		assertPublic: async (url) => {
			called.push(url);
			return { ok: true };
		}
	};
	const r = await assertInboundPublic(ctx, 'https://gateway.example/check');
	assert.equal(r.ok, true);
	assert.deepEqual(called, ['https://gateway.example/check']);
});

test('guard: error — a private verify_url is refused by the guard, not fetched', async () => {
	const ctx = {
		assertPublic: async () => ({ ok: false, reason: 'refusing to call a non-public address (169.254.169.254)' })
	};
	const r = await assertInboundPublic(ctx, 'http://169.254.169.254/');
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'refusing to call a non-public address (169.254.169.254)');
});