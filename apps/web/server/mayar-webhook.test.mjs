// apps/web/server/mayar-webhook.test.mjs — the inbound Mayar settlement route
// (H1 transport).
//
// Why this file exists: the route is THIN I/O — it must 404 when disabled,
// parse only the hinted `data.id`/`data.transactionId` (never an amount/status),
// and hand every money decision to the injected settlement seam. These tests pin
// the transport split with fake req/res and an injected `settle` seam (no
// network, no DATABASE_URL, no MAYAR_API_KEY).
//
// Run: node --test apps/web/server/mayar-webhook.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerMayarWebhook, hintedIdOf } from './mayar-webhook.mjs';

function makeRes() {
	const r = {
		statusCode: 200,
		body: undefined,
		headersSent: false,
		status(c) {
			r.statusCode = c;
			return r;
		},
		json(o) {
			r.body = o;
			r.headersSent = true;
			return r;
		}
	};
	return r;
}

function makeApp() {
	const routes = [];
	return {
		routes,
		post(path, ...handlers) {
			routes.push({ path, handlers });
		},
		use() {}
	};
}

function makeReq(body) {
	return {
		body: body === undefined ? Buffer.from('') : Buffer.from(body),
		headers: {}
	};
}

function runLastHandler(app, req, res) {
	const handlers = app.routes[0].handlers;
	// middleware (rate-limit, raw parser) then the final async handler.
	const last = handlers[handlers.length - 1];
	return last(req, res);
}

// --- disabled → 404 ----------------------------------------------------------

test('route: MAYAR_WEBHOOK_ENABLED off answers 404 even with a key', async () => {
	const app = makeApp();
	registerMayarWebhook(app, {
		enabled: () => false,
		getClient: () => ({ getTransaction: async () => ({ ok: false, kind: 'mayar_rejected', status: 404 }) }),
		getDb: () => ({})
	});
	assert.equal(app.routes[0].path, '/api/mayar/webhook');
	const res = makeRes();
	await runLastHandler(app, makeReq(JSON.stringify({ event: 'payment.received', data: { id: 'tx' } })), res);
	assert.equal(res.statusCode, 404);
});

// --- pay/amount/id decisions are never parsed from the body -------------------

test('route: the body yields only the hinted id; amount/status are never read', () => {
	const body = JSON.stringify({ event: 'payment.received', data: { id: 'tx_hint', transactionId: 'tx_hint2', status: 'paid', amount: 30000 } });
	const approx = hintedIdOf(JSON.parse(body));
	assert.equal(approx, 'tx_hint2', 'the hinted id prefers data.transactionId, then data.id');
});

test('route: a paid hint with an injected settle success is acknowledged', async () => {
	const app = makeApp();
	let seenHintedId = null;
	registerMayarWebhook(app, {
		enabled: () => true,
		getClient: () => ({ getTransaction: async () => ({ ok: false, kind: 'mayar_rejected', status: 404 }) }),
		getDb: () => ({}),
		settle: async (_active, _db, hintedId) => {
			seenHintedId = hintedId;
			return { ok: true, granted: true, alreadyConfirmed: false, paymentId: 'pay_1', subscriptionId: 'sub_1' };
		}
	});
	const res = makeRes();
	await runLastHandler(
		app,
		makeReq(JSON.stringify({ event: 'payment.received', data: { id: 'tx_hint' } })),
		res
	);
	assert.equal(seenHintedId, 'tx_hint');
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.settled, true);
	assert.equal(res.body.granted, true);
});

// --- refusal is ACKed 200 (no retry) -----------------------------------------

test('route: a refusal (not_paid) is ACKed 200 so the gateway does not retry', async () => {
	const app = makeApp();
	registerMayarWebhook(app, {
		enabled: () => true,
		getClient: () => ({ getTransaction: async () => ({ ok: false, kind: 'mayar_rejected', status: 404 }) }),
		getDb: () => ({}),
		settle: async () => ({ ok: false, ack: true, reason: 'not_paid' })
	});
	const res = makeRes();
	await runLastHandler(app, makeReq(JSON.stringify({ event: 'payment.received', data: { id: 'tx' } })), res);
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.settled, false);
	assert.equal(res.body.reason, 'not_paid');
});

test('route: a config error at client build is fail-closed (404), not a crash', async () => {
	const app = makeApp();
	registerMayarWebhook(app, {
		enabled: () => true,
		getClient: () => {
			const err = new Error('mix');
			err.name = 'MayarConfigError';
			throw err;
		},
		getDb: () => ({})
	});
	const res = makeRes();
	await runLastHandler(app, makeReq(JSON.stringify({ event: 'payment.received', data: { id: 'tx' } })), res);
	assert.equal(res.statusCode, 404);
});