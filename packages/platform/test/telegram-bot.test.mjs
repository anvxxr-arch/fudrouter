// packages/platform/test/telegram-bot.test.mjs — the Telegram adapter (C1).
//
// Why this file exists: the adapter is THIN I/O — it must translate a Telegram
// update into a call on the shared core and render the reply, and it must
// NEVER make a money decision itself. These tests pin that split with fake
// transports and in-memory money seams (no network, no DATABASE_URL):
//
//   1. unknown plan                 -> "unknown plan" (never a broken QR);
//   2. /pay valid                   -> the ONE core paymentPrompt QR + amount;
//   3. admin Yes on a sound claim   -> confirmAndGrant grants, member told;
//   4. admin No                     -> decideClaim follows up, nothing granted;
//
// plus the cross-channel invariant (DoD): the listing the adapter renders is
// byte-identical to the shared `plansMessage()`, and the /pay prompt is the
// core `paymentPrompt` — never a local pricing copy.
//
// In-memory seams obey the same durable idempotency contracts the drizzle ones
// do (one gatewayRef = one payment; one paymentId = one subscription) so the
// assertions cover the DECISION, not Postgres.
//
// Run: node --test packages/platform/test/telegram-bot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	handleMessage,
	handleCallbackQuery,
	plansText,
	unknownPlanText
} from '../server/telegram-bot.ts';
import { plansMessage, marketplaceListing, formatIdr, paymentPrompt } from '../server/bots.ts';
import { PLANS, qrisFor } from '../server/payments.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

const PLAN = 'sub_7d';
const PRICE = PLANS[PLAN].priceIdr;

// ------------------------------- fakes -------------------------------------

/** In-memory GatewayStore honouring gateway.ts's idempotency-on-ref contract. */
function fakeGatewayStore() {
	const rows = new Map();
	return {
		created: [],
		async findPayment(gatewayRef) {
			return rows.get(gatewayRef) ?? null;
		},
		async insertPayment(payment) {
			const existing = rows.get(payment.gatewayRef);
			if (existing) return existing;
			const record = { id: 'pay_1', ...payment };
			rows.set(payment.gatewayRef, record);
			this.created.push(record);
			return record;
		}
	};
}

/** In-memory PaymentConfirmStore honouring the idempotent status-flip contract. */
function fakeConfirmStore() {
	return {
		confirmed: [],
		async confirmPayment(record) {
			this.confirmed.push(record);
			return { id: record.id, alreadyConfirmed: false };
		}
	};
}

/** In-memory SubscriptionWriter honouring the one-paymentId = one-window contract. */
function fakeWriter() {
	return {
		granted: [],
		async grant(args) {
			this.granted.push(args);
			return { id: 'sub_1', created: true };
		}
	};
}

/** A full deps bag with fresh fakes and recording senders. */
function makeDeps(overrides = {}) {
	const gatewayStore = fakeGatewayStore();
	const paymentConfirmStore = fakeConfirmStore();
	const subscriptionWriter = fakeWriter();
	const sent = [];
	const answered = [];
	const deps = {
		adminChatId: '9000',
		now: () => NOW,
		accountIdFor: async () => 'acc_1',
		findPendingPayment: async () => null,
		recordClaim: async () => ({ ok: true }),
		resolveClaim: async () => null,
		gatewayStore,
		paymentConfirmStore,
		subscriptionWriter,
		async send(chatId, text, opts) {
			sent.push({ chatId, text, opts });
		},
		async answerCallback(id, text) {
			answered.push({ id, text });
		},
		...overrides
	};
	return { deps, sent, answered, gatewayStore, paymentConfirmStore, subscriptionWriter };
}

/** A member's `/pay` message. */
function payMessage(planId = PLAN) {
	return {
		chatId: '100',
		username: '@member',
		updateId: 42,
		text: `/pay ${planId}`
	};
}

/** A proof-upload message. */
function proofMessage() {
	return {
		chatId: '100',
		username: '@member',
		updateId: 43,
		photo: { fileId: 'FILE_1', url: 'https://cdn.example/proof.png' }
	};
}

/** A valid claim record for PLAN (whole-rupiah amount matches the price). */
function claimRecord(overrides = {}) {
	return {
		id: 'pay_1',
		gatewayRef: 'purchase:tg:acc_1:42',
		gateway: 'qris-native',
		accountId: 'acc_1',
		channel: 'telegram',
		plan: PLAN,
		amountIdr: PRICE,
		raw: { proofUrl: 'https://cdn.example/proof.png' },
		...overrides
	};
}

// ---------------------------------------------------------------------------

test('tg: unknown plan — /pay <typo> answers "unknown plan" and mints nothing', async () => {
	const { deps, sent, gatewayStore } = makeDeps();
	await handleMessage(deps, payMessage('sub_999d'));

	assert.equal(sent.length, 1);
	assert.equal(sent[0].text, unknownPlanText('sub_999d'));
	assert.match(sent[0].text, /Unknown plan/);
	// No payment row was minted: paymentPrompt is the one source and it refused.
	assert.equal(gatewayStore.created.length, 0);
	assert.equal(sent[0].opts, undefined);
});

test('tg: /pay valid — renders the ONE core paymentPrompt QR and amount', async () => {
	const { deps, sent, gatewayStore } = makeDeps();

	const msg = payMessage();
	await handleMessage(deps, msg);

	const prompt = paymentPrompt(PLAN);
	assert.ok(prompt, 'paymentPrompt must resolve for a real plan');

	// The adapter sent exactly the core prompt text — byte-identical pricing.
	assert.equal(sent.length, 1);
	assert.equal(sent[0].text, prompt.text);

	// The QR is the core qrisFor amount, not a locally rebuilt payload.
	assert.equal(sent[0].opts.qris, qrisFor(PRICE));

	// One pending payment minted via createPayment (channel telegram).
	assert.equal(gatewayStore.created.length, 1);
	assert.equal(gatewayStore.created[0].plan, PLAN);
	assert.equal(gatewayStore.created[0].channel, 'telegram');
	assert.equal(gatewayStore.created[0].amountIdr, PRICE);
});

test('tg: pricing identical — plansText is byte-identical to the shared listing', () => {
	const text = plansText();
	// The adapter renders bots.ts's single shared listing — no local copy, so
	// Discord and Telegram cannot diverge on a price or plan name.
	assert.equal(text, plansMessage());
	const listing = marketplaceListing();
	for (const item of listing.items) {
		assert.ok(item.priceIdr === PLANS[item.id].priceIdr);
		assert.ok(
			text.includes(formatIdr(item.priceIdr)),
			`plansText must include the core price for ${item.id}: ${formatIdr(item.priceIdr)}`
		);
	}
});

test('tg: admin Yes — a sound claim grants (kind granted) and tells the member', async () => {
	const confirmStore = fakeConfirmStore();
	const writer = fakeWriter();
	const { deps, sent, answered } = makeDeps({
		resolveClaim: async () => claimRecord(),
		paymentConfirmStore: confirmStore,
		subscriptionWriter: writer
	});

	const result = await handleCallbackQuery(deps, {
		id: 'cb_1',
		data: 'yes',
		answer: 'yes',
		claim: { paymentId: 'pay_1', memberChatId: '100', memberName: '@member' }
	});

	assert.equal(result.kind, 'granted');
	assert.equal(result.subscriptionId, 'sub_1');
	assert.equal(result.plan, PLAN);

	// Durable loop: one payment confirmed + one frsubs window.
	assert.equal(confirmStore.confirmed.length, 1);
	assert.equal(confirmStore.confirmed[0].id, 'pay_1');
	assert.equal(writer.granted.length, 1);
	assert.equal(writer.granted[0].plan, PLAN);
	assert.equal(writer.granted[0].priceIdr, PRICE);

	// The member is told the key is published; the callback is acked.
	assert.ok(sent.some((s) => s.chatId === '100' && /published/.test(s.text)));
	assert.ok(answered.some((a) => a.id === 'cb_1' && /Granted/.test(a.text)));
});

test('tg: admin No — decides follow-up, grants nothing', async () => {
	const confirmStore = fakeConfirmStore();
	const writer = fakeWriter();
	const { deps, sent, answered } = makeDeps({
		resolveClaim: async () => claimRecord(),
		paymentConfirmStore: confirmStore,
		subscriptionWriter: writer
	});

	const result = await handleCallbackQuery(deps, {
		id: 'cb_2',
		data: 'no',
		answer: 'no',
		claim: { paymentId: 'pay_1', memberChatId: '100', memberName: '@member' }
	});

	assert.equal(result.kind, 'follow_up');
	// Money never moved: no confirm, no grant.
	assert.equal(confirmStore.confirmed.length, 0);
	assert.equal(writer.granted.length, 0);
	// The member reads the core follow-up (names the plan + amount).
	assert.ok(sent.some((s) => s.chatId === '100' && /could not confirm/.test(s.text)));
	assert.ok(answered.some((a) => a.id === 'cb_2'));
});

test('tg: proof upload — records the claim and prompts the admin with core text', async () => {
	const claims = [];
	const { deps, sent } = makeDeps({
		findPendingPayment: async () => ({ paymentId: 'pay_1', planId: PLAN }),
		recordClaim: async ({ paymentId, proofUrl }) => {
			claims.push({ paymentId, proofUrl });
			return { ok: true };
		}
	});

	await handleMessage(deps, proofMessage());

	assert.equal(claims.length, 1);
	assert.equal(claims[0].paymentId, 'pay_1');
	assert.equal(claims[0].proofUrl, 'https://cdn.example/proof.png');

	// The admin prompt is the core adminApprovalPrompt text, not a local copy
	// (it names the plan id and the formatted amount, exactly as bots.ts renders).
	const adminMsg = sent.find((s) => s.chatId === '9000');
	assert.ok(adminMsg, 'admin receives the approval prompt');
	assert.match(adminMsg.text, new RegExp(PLAN));
	assert.match(adminMsg.text, new RegExp(formatIdr(PRICE)));
	assert.match(adminMsg.text, /Did this user really make the transaction/);
	assert.ok(adminMsg.opts.buttons.length === 2);
	assert.equal(adminMsg.opts.claim.paymentId, 'pay_1');
});

test('tg: admin Yes on a short amount — money rule refuses, still follow-up', async () => {
	// The claim amount does not equal the plan price; resolveGrant must refuse
	// even though the admin said yes (a short payment is not a discount).
	const confirmStore = fakeConfirmStore();
	const writer = fakeWriter();
	const { deps } = makeDeps({
		resolveClaim: async () => claimRecord({ amountIdr: PRICE - 1000 }),
		paymentConfirmStore: confirmStore,
		subscriptionWriter: writer
	});

	const result = await handleCallbackQuery(deps, {
		id: 'cb_3',
		data: 'yes',
		answer: 'yes',
		claim: { paymentId: 'pay_1', memberChatId: '100', memberName: '@member' }
	});

	assert.equal(result.kind, 'follow_up');
	assert.match(result.reason, /amount_mismatch/);
	assert.equal(confirmStore.confirmed.length, 0);
	assert.equal(writer.granted.length, 0);
});