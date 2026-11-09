// apps/web/server/telegram-transport.test.mjs — the Telegram webhook transport
// (CS3).
//
// Why this file exists: the transport is THIN I/O — it must verify Telegram's
// secret-token header and dispatch an update into the shared handlers
// (telegram-bot.ts), and it must NEVER make a money decision itself. These tests
// pin that split with fake req/res and injected handlers/seams (no network, no
// DATABASE_URL, no TELEGRAM_BOT_TOKEN):
//
//   1. verifySecretToken — constant-time match/mismatch;
//   2. decodeCallbackData — round-trips and refuses malformed data;
//   3. handleTelegramWebhook — message update dispatched to the handler;
//   4. handleTelegramWebhook — callback query decoded + dispatched;
//   5. handleTelegramWebhook — unknown callback_data acks, never grants;
//   6. handleTelegramWebhook — absent secret → disabled 404 (never a crash);
//   7. handleTelegramWebhook — bad secret → 401 (fail closed);
//   8. handleTelegramWebhook — a proof upload flows through the REAL core
//      handler into the injected claim seam (no core duplication).
//
// Run: node --test apps/web/server/telegram-transport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	verifySecretToken,
	encodeCallbackData,
	decodeCallbackData,
	handleTelegramWebhook,
	TELEGRAM_SECRET_TOKEN_HEADER
} from './telegram-transport.mjs';

const SECRET = 'telegram-webhook-secret';

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

function makeReq(body, headers = {}) {
	return { body, headers };
}

const silentLog = { warn() {}, error() {} };

// Defaults: no DB, no outbound. Override `handleMessage`/`handleCallbackQuery`
// in tests that want to observe dispatch; leave them OUT (pass `undefined`) to
// exercise the REAL telegram-bot.ts handlers with injected seams.
function ctx(overrides = {}) {
	const out = {
		getSecret: () => SECRET,
		handleMessage: async () => {},
		handleCallbackQuery: async () => ({ kind: 'granted' }),
		send: async () => {},
		answerCallback: async () => {},
		approvers: [],
		log: silentLog
	};
	const merged = { ...out, ...overrides };
	// A caller that explicitly passes `undefined` means "use the real handler".
	if ('handleMessage' in overrides && overrides.handleMessage === undefined) {
		delete merged.handleMessage;
	}
	if ('handleCallbackQuery' in overrides && overrides.handleCallbackQuery === undefined) {
		delete merged.handleCallbackQuery;
	}
	return merged;
}

// ---------------------------------------------------------------------------

test('verifySecretToken: matching token passes, mismatch fails', () => {
	assert.equal(verifySecretToken(SECRET, SECRET), true);
	assert.equal(verifySecretToken(`  ${SECRET}  `, SECRET), true, 'the header is trimmed before compare');

	assert.equal(verifySecretToken('other', SECRET), false);
	assert.equal(verifySecretToken(undefined, SECRET), false);
	assert.equal(verifySecretToken(SECRET, ''), false, 'an empty expected secret never passes');
	assert.equal(verifySecretToken(SECRET, undefined), false);
});

test('decodeCallbackData: round-trips an answer+claim and refuses garbage', () => {
	const claim = { paymentId: 'pay_1', memberChatId: '100', memberName: '@member' };
	const data = encodeCallbackData('yes', claim);
	assert.equal(typeof data, 'string');

	const decoded = decodeCallbackData(data);
	assert.equal(decoded.answer, 'yes');
	assert.deepEqual(decoded.claim, claim);

	assert.equal(decodeCallbackData(''), null);
	assert.equal(decodeCallbackData('not-json'), null);
	assert.equal(decodeCallbackData(JSON.stringify({ a: 'maybe' })), null, 'non-yes/no fails closed');
	assert.equal(decodeCallbackData(JSON.stringify({ a: 'yes' })), null, 'missing paymentId fails closed');
});

test('webhook: a message update is normalised and dispatched to the handler', async () => {
	const seen = [];
	const c = ctx({ handleMessage: async (deps, msg) => seen.push(msg) });
	const req = makeReq(
		{
			update_id: 42,
			message: {
				message_id: 1,
				from: { id: 100, username: 'member' },
				chat: { id: 100 },
				text: '/pay sub_7d'
			}
		},
		{ [TELEGRAM_SECRET_TOKEN_HEADER]: SECRET }
	);

	const res = makeRes();
	await handleTelegramWebhook(req, res, c);

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.ok, true);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].chatId, '100');
	assert.equal(seen[0].username, '@member');
	assert.equal(seen[0].updateId, 42);
	assert.equal(seen[0].text, '/pay sub_7d');
});

test('webhook: a callback query is decoded and dispatched to the handler', async () => {
	const claim = { paymentId: 'pay_1', memberChatId: '100', memberName: '@member' };
	const seen = [];
	const c = ctx({
		handleCallbackQuery: async (deps, query) => {
			seen.push(query);
			return { kind: 'granted', subscriptionId: 'sub_1', plan: 'sub_7d' };
		}
	});
	const req = makeReq(
		{ update_id: 43, callback_query: { id: 'cb_1', data: encodeCallbackData('yes', claim) } },
		{ [TELEGRAM_SECRET_TOKEN_HEADER]: SECRET }
	);

	const res = makeRes();
	await handleTelegramWebhook(req, res, c);

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.result.kind, 'granted');
	assert.equal(seen.length, 1);
	assert.equal(seen[0].id, 'cb_1');
	assert.equal(seen[0].answer, 'yes');
	assert.equal(seen[0].claim.paymentId, 'pay_1');
});

test('webhook: unknown callback_data acks "Unknown action", never reaches the handler', async () => {
	const grante = [];
	const answered = [];
	const c = ctx({
		handleCallbackQuery: async () => {
			grante.push(1);
			return { kind: 'granted' };
		},
		answerCallback: async (id, text) => answered.push({ id, text })
	});
	const req = makeReq(
		{ update_id: 44, callback_query: { id: 'cb_2', data: 'garbage' } },
		{ [TELEGRAM_SECRET_TOKEN_HEADER]: SECRET }
	);

	const res = makeRes();
	await handleTelegramWebhook(req, res, c);

	assert.equal(res.statusCode, 200);
	assert.equal(answered[0].text, 'Unknown action');
	assert.equal(grante.length, 0, 'a malformed callback must not reach the grant handler');
});

test('webhook: absent secret → disabled 404, no dispatch', async () => {
	const req = makeReq({ update_id: 1, message: { chat: { id: 1 }, text: '/plans' } });
	const res = makeRes();

	await handleTelegramWebhook(req, res, ctx({ getSecret: () => null }));

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.error.code, 'TELEGRAM_DISABLED');
});

test('webhook: missing or mismatched secret → 401, no dispatch', async () => {
	let dispatched = 0;
	const c = ctx({
		handleMessage: async () => {
			dispatched += 1;
		}
	});

	// mismatch
	let res = makeRes();
	await handleTelegramWebhook(
		makeReq({ update_id: 1, message: {} }, { [TELEGRAM_SECRET_TOKEN_HEADER]: 'wrong' }),
		res,
		c
	);
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.error.code, 'TELEGRAM_BAD_SECRET');

	// missing header
	res = makeRes();
	await handleTelegramWebhook(makeReq({ update_id: 1, message: {} }, {}), res, c);
	assert.equal(res.statusCode, 401);

	assert.equal(dispatched, 0, 'an unverified request never reaches the handler');
});

test('webhook: a proof upload flows through the REAL core handler into the claim seam', async () => {
	const claimed = [];
	const sent = [];
	const c = ctx({
		// Opt out of the defaults so the REAL telegram-bot.ts handleMessage runs.
		handleMessage: undefined,
		handleCallbackQuery: undefined,
		accountIdFor: async () => 'acc_1',
		findPendingPayment: async () => ({ paymentId: 'pay_1', planId: 'sub_7d' }),
		recordClaim: async (args) => {
			claimed.push(args);
			return { ok: true };
		},
		send: async (chatId, text, opts) => sent.push({ chatId, text, opts }),
		approvers: ['9000']
	});
	const req = makeReq(
		{
			update_id: 45,
			message: {
				chat: { id: 100 },
				from: { username: 'member' },
				photo: [{ file_id: 'FILE_1' }, { file_id: 'FILE_2' }]
			}
		},
		{ [TELEGRAM_SECRET_TOKEN_HEADER]: SECRET }
	);

	const res = makeRes();
	await handleTelegramWebhook(req, res, c);

	assert.equal(res.statusCode, 200);
	assert.equal(claimed.length, 1);
	assert.equal(claimed[0].paymentId, 'pay_1');
	assert.equal(claimed[0].proofUrl, 'FILE_2', 'the largest photo size is the proof');
	assert.ok(
		sent.some((s) => s.chatId === '9000' && /Payment claim/.test(s.text)),
		'the primary approver receives the core approval prompt'
	);
});