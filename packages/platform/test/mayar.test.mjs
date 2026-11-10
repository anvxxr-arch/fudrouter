// packages/platform/test/mayar.test.mjs — the Mayar gateway adapter contract.
//
// Why this exists: the adapter owns the ONLY vendor-specific network call, and
// the things that must not drift are (1) the request shape (URL, Bearer header,
// body), (2) the error taxonomy (never the vendor's JSON), and (3) the secret:
// the API key may appear in the Authorization header and NOWHERE ELSE — not in a
// log line, not in an error `message`. Everything here runs against an injected
// fake fetch, so no network is touched.
//
// Flat top-level tests (no nesting): node:test runs a nested test() only when
// the parent awaits it.
//
// Run: node --test packages/platform/test/mayar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	MayarClient,
	mayarApiKey,
	mayarBaseUrl,
	mayarWebhookEnabled,
	mayarClientFromEnv,
	MayarConfigError,
	MAYAR_API_BASE_DEFAULT,
	MAYAR_API_KEY_ENV,
	MAYAR_API_BASE_ENV,
	MAYAR_WEBHOOK_ENABLED_ENV
} from '../server/mayar.ts';

const KEY = 'prod.jwt.header.payload-with-api.mayar.id';
const BASE = 'https://api.mayar.id/hl/v2';

/** A fake fetch that records every call and returns a scripted response. */
function fakeFetch(respond) {
	const calls = [];
	const fn = async (baseUrl, allowPrivate, pathSuffix, init) => {
		calls.push({ baseUrl, allowPrivate, pathSuffix, init });
		return typeof respond === 'function' ? respond(pathSuffix, init) : respond;
	};
	fn.calls = calls;
	return fn;
}

function okJson(status, data) {
	return {
		ok: true,
		response: { status, text: async () => JSON.stringify(data) }
	};
}

function client(respond, apiKey = KEY, baseUrl = BASE) {
	const fetchFn = fakeFetch(respond);
	const c = new MayarClient({ apiKey, baseUrl, fetchFn, timeoutMs: 5000, allowPrivate: false });
	return { c, fetchFn };
}

// --- request shape -----------------------------------------------------------

test('createPayment posts to /payments/create with a Bearer header and exact body', async () => {
	const { c, fetchFn } = client(
		okJson(200, { statusCode: 200, data: { id: 'req_1', transactionId: 'tx_1', link: 'https://x/l' } })
	);
	const r = await c.createPayment({ name: 'n', amount: 30000, email: 'a@b.c', redirectUrl: 'https://r', expiredAt: new Date('2026-11-20T00:00:00.000Z') });

	assert.equal(r.ok, true);
	assert.equal(fetchFn.calls.length, 1);
	const call = fetchFn.calls[0];
	assert.equal(call.baseUrl, BASE);
	assert.equal(call.allowPrivate, false);
	assert.equal(call.pathSuffix, '/payments/create');
	assert.equal(call.init.method, 'POST');
	assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
	assert.equal(call.init.headers['content-type'], 'application/json');
	const body = JSON.parse(call.init.body);
	assert.deepEqual(body, {
		name: 'n',
		amount: 30000,
		email: 'a@b.c',
		redirectUrl: 'https://r',
		expiredAt: '2026-11-20T00:00:00.000Z'
	});
});

test('createPayment omits absent optional fields from the body', async () => {
	const { c, fetchFn } = client(okJson(200, { data: { id: 'i', transactionId: 't', link: 'l' } }));
	await c.createPayment({ name: 'n', amount: 30000 });
	const body = JSON.parse(fetchFn.calls[0].init.body);
	assert.deepEqual(body, { name: 'n', amount: 30000 });
});

test('getTransaction fetches the exact /transactions/{id} path', async () => {
	const { c, fetchFn } = client(okJson(200, { data: { id: 'tx_1', status: 'paid', amount: 30000 } }));
	const r = await c.getTransaction('tx_1');
	assert.equal(r.ok, true);
	assert.equal(fetchFn.calls[0].pathSuffix, '/transactions/tx_1');
	assert.equal(fetchFn.calls[0].init.method, 'GET');
	assert.equal(r.value.status, 'paid');
	assert.equal(r.value.amount, 30000);
});

test('listTransactions builds a cursor query and surfaces transactionId', async () => {
	const page = {
		statusCode: 200,
		data: [
			{ transactionId: 'tx_a', paymentLinkTransactionId: 'tx_a', status: 'settled', amount: 1000 },
			{ transactionId: 'tx_b', status: 'settled', amount: 2000 }
		],
		hasMore: true,
		nextStartingAfter: '1768288611042'
	};
	const { c, fetchFn } = client(okJson(200, page));
	const r = await c.listTransactions({ limit: 7, startingAfter: '123' });
	assert.equal(r.ok, true);
	assert.equal(fetchFn.calls[0].pathSuffix, '/transactions?limit=7&startingAfter=123');
	assert.equal(r.value.items.length, 2);
	assert.equal(r.value.items[0].id, 'tx_a');
	assert.equal(r.value.hasMore, true);
	assert.equal(r.value.nextStartingAfter, '1768288611042');
});

// --- error taxonomy ----------------------------------------------------------

test('a 401 maps to mayar_rejected without the vendor body or the key', async () => {
	const secretBody = JSON.stringify({ messages: `echo ${KEY}`, data: null });
	const { c } = client({ ok: true, response: { status: 401, text: async () => secretBody } });
	const r = await c.createPayment({ name: 'n', amount: 30000 });
	assert.equal(r.ok, false);
	assert.equal(r.kind, 'mayar_rejected');
	assert.ok(!r.message.includes(KEY), 'the key must never appear in an error message');
	assert.ok(!r.message.includes('echo'), 'the vendor JSON body is never folded into an error');
});

test('a 500 maps to mayar_unavailable', async () => {
	const { c } = client({ ok: true, response: { status: 500, text: async () => '{}' } });
	const r = await c.createPayment({ name: 'n', amount: 30000 });
	assert.equal(r.ok, false);
	assert.equal(r.kind, 'mayar_unavailable');
});

test('a transport failure from the injected fetch maps to mayar_unavailable, no key', async () => {
	const { c } = client({ ok: false, message: 'refusing private address' });
	const r = await c.getTransaction('tx');
	assert.equal(r.ok, false);
	assert.equal(r.kind, 'mayar_unavailable');
	assert.ok(!r.message.includes(KEY));
});

test('a non-object envelope maps to mayar_bad_response', async () => {
	const { c } = client(okJson(200, ['not', 'an', 'object']));
	const r = await c.getTransaction('tx');
	assert.equal(r.ok, false);
	assert.equal(r.kind, 'mayar_bad_response');
});

test('a create response missing link is mayar_bad_response, not a fabricated link', async () => {
	const { c } = client(okJson(200, { data: { id: 'i', transactionId: 't' } }));
	const r = await c.createPayment({ name: 'n', amount: 30000 });
	assert.equal(r.ok, false);
	assert.equal(r.kind, 'mayar_bad_response');
});

test('the key appears ONLY in the Authorization header across a full happy path', async () => {
	const { c, fetchFn } = client(okJson(200, { data: { id: 'i', transactionId: 't', link: 'l' } }));
	const r = await c.createPayment({ name: 'n', amount: 5000 });
	assert.equal(r.ok, true);
	const call = fetchFn.calls[0];
	assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
	assert.ok(!call.pathSuffix.includes(KEY));
	assert.ok(!call.init.body.includes(KEY));
	assert.ok(!r.value.link.includes(KEY));
});

// --- env ---------------------------------------------------------------------

test('mayarApiKey/baseUrl/webhookEnabled read the named env vars', () => {
	assert.equal(mayarApiKey({ [MAYAR_API_KEY_ENV]: ' x ' }), 'x');
	assert.equal(mayarApiKey({}), null);
	assert.equal(mayarApiKey({ [MAYAR_API_KEY_ENV]: '' }), null);
	assert.equal(mayarBaseUrl({}), MAYAR_API_BASE_DEFAULT);
	assert.equal(mayarBaseUrl({ [MAYAR_API_BASE_ENV]: ' https://api.mayar.id/hl/v2/// ' }), 'https://api.mayar.id/hl/v2');
	assert.equal(mayarWebhookEnabled({}), false);
	assert.equal(mayarWebhookEnabled({ [MAYAR_WEBHOOK_ENABLED_ENV]: 'true' }), true);
});

test('mayarClientFromEnv returns null when MAYAR_API_KEY is unset (fail closed)', () => {
	assert.equal(mayarClientFromEnv({}), null);
});

test('mayarClientFromEnv throws on a provable sandbox/production mix', () => {
	const sandboxKey = makeKey('api.mayar.io');
	assert.throws(
		() => mayarClientFromEnv({ [MAYAR_API_KEY_ENV]: sandboxKey, [MAYAR_API_BASE_ENV]: 'https://api.mayar.id/hl/v2' }, fakeFetch()),
		MayarConfigError
	);
});

// A three-part JWT whose payload names a Mayar host (env-owned, not verified).
function makeKey(host) {
	const payload = Buffer.from(JSON.stringify({ iss: `https://${host}/` })).toString('base64url');
	return `header.${payload}.sig`;
}