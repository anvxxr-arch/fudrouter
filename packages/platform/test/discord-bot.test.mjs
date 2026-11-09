// packages/platform/test/discord-bot.test.mjs — the Discord payment bot adapter
// (C2) four pure cases. Transport and the confirm→grant seam are faked; no
// network, no database.
//
// Run: node --test packages/platform/test/discord-bot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPay, handleApproval } from '../server/discord-bot.ts';
import { unknownPlanMessage } from '../server/bots.ts';

const NOW = new Date('2026-10-31T12:00:00Z');
const payment = { paymentId: 'pay_1', plan: 'sub_7d', amountIdr: 30000, status: 'claimed' };

// 1 — unknown plan → the shared "unknown plan" refusal (no broken QR).
test('renderPay: unknown — an unknown plan yields the shared unknown-plan refusal', () => {
	const out = renderPay('sub_999d');
	assert.equal(out.ok, false);
	assert.equal(out.text, unknownPlanMessage());
});

// 2 — /pay valid → QR + amount (price identical to core's paymentPrompt).
test('renderPay: success — a known plan yields the QRIS and the amount', () => {
	const out = renderPay('sub_7d');
	assert.equal(out.ok, true);
	assert.equal(out.amountIdr, 30000);
	assert.ok(out.qris.length > 0);
	assert.match(out.text, /Rp 30\.000/);
	assert.match(out.text, /QRIS/);
});

// 3 — admin Yes + grant ok → grant (confirm seam invoked once, no follow-up).
test('handleApproval: yes — a matching payment calls the grant seam once', async () => {
	const replies = [];
	const sent = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => replies.push({ i, m }),
		send: async (ch, m) => sent.push({ ch, m }),
		grant: {
			confirmAndGrant: async (p) => {
				confirmed.push(p);
				return { ok: true, subscriptionId: 'sub_1', plan: p.plan, days: 7 };
			}
		},
		approvers: ['admin-1'],
		approverUsers: ['admin'],
		now: NOW
	};
	const interaction = { id: 'i1', userId: 'admin', userDisplayName: 'admin', channelId: 'admin-1' };

	await handleApproval(interaction, 'yes', payment, ctx);

	assert.equal(confirmed.length, 1);
	assert.equal(confirmed[0].paymentId, 'pay_1');
	assert.equal(confirmed[0].plan, 'sub_7d');
	assert.match(replies[0].m, /Approved/);
	assert.match(replies[0].m, /7 days/);
	assert.equal(sent.length, 0);
});

// 4 — admin No → followUp (no grant; member follow-up via followUpMessage).
test('handleApproval: no — follows up and never grants', async () => {
	const replies = [];
	const sent = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => replies.push({ i, m }),
		send: async (ch, m) => sent.push({ ch, m }),
		grant: {
			confirmAndGrant: async () => {
				confirmed.push(1);
				throw new Error('grant must not be called on "no"');
			}
		},
		approvers: ['admin-1'],
		approverUsers: ['admin'],
		now: NOW
	};
	const interaction = {
		id: 'i2',
		userId: 'admin',
		userDisplayName: 'admin',
		channelId: 'admin-1',
		memberChannelId: 'dm-9',
		componentId: 'approval:no:pay_1'
	};

	await handleApproval(interaction, 'no', payment, ctx);

	assert.equal(confirmed.length, 0);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].ch, 'dm-9');
	assert.match(sent[0].m, /We could not confirm your payment for 7 Days \(Rp 30\.000\)/);
	assert.match(sent[0].m, /complete the QRIS payment/);
});


// --- C2: actor authorization -------------------------------------------------

test('handleApproval: a non-approver is refused before any grant (deny-all)', async () => {
	const replies = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => replies.push({ i, m }),
		send: async (ch, m) => {},
		grant: {
			confirmAndGrant: async () => {
				confirmed.push(1);
				throw new Error('grant must not run for a non-approver');
			}
		},
		approvers: ['admin-1'],
		approverUsers: [], // empty => deny all
		now: NOW
	};
	const interaction = {
		id: 'i3',
		userId: 'stranger',
		userDisplayName: 'stranger',
		channelId: 'admin-1'
	};

	await handleApproval(interaction, 'yes', payment, ctx);

	assert.equal(confirmed.length, 0, 'no grant for a non-approver');
	assert.ok(replies.some((r) => /not an approver/i.test(r.m)));
});

test('handleApproval: an allow-listed discord user is authorized', async () => {
	const replies = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => replies.push({ i, m }),
		send: async (ch, m) => {},
		grant: {
			confirmAndGrant: async (p) => {
				confirmed.push(p);
				return { ok: true, subscriptionId: 'sub_1', plan: p.plan, days: 7 };
			}
		},
		approvers: ['admin-1'],
		approverUsers: ['123456789012345678'],
		now: NOW
	};
	const interaction = {
		id: 'i4',
		userId: '123456789012345678',
		userDisplayName: 'admin',
		channelId: 'admin-1'
	};

	await handleApproval(interaction, 'yes', payment, ctx);

	assert.equal(confirmed.length, 1);
});

// --- C3: answeredBy persist + status flip ------------------------------------

test('handleApproval: a "no" records the answer and flips the payment to rejected', async () => {
	const answers = [];
	const rejected = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => {},
		send: async (ch, m) => {},
		grant: {
			confirmAndGrant: async () => {
				confirmed.push(1);
				throw new Error('grant must not run on "no"');
			}
		},
		approvers: ['admin-1'],
		approverUsers: ['admin'],
		now: NOW,
		answerApproval: async (paymentId, answeredBy, answeredAt) => answers.push({ paymentId, answeredBy, answeredAt }),
		rejectPayment: async (paymentId) => rejected.push(paymentId)
	};
	const interaction = {
		id: 'i5',
		userId: 'admin',
		userDisplayName: 'admin',
		channelId: 'admin-1',
		memberChannelId: 'dm-9'
	};

	await handleApproval(interaction, 'no', payment, ctx);

	assert.equal(confirmed.length, 0);
	assert.deepEqual(answers, [{ paymentId: 'pay_1', answeredBy: 'admin', answeredAt: NOW.getTime() }]);
	assert.deepEqual(rejected, ['pay_1']);
});

test('handleApproval: a "yes" records the answer and does not reject', async () => {
	const answers = [];
	const rejected = [];
	const confirmed = [];
	const ctx = {
		reply: async (i, m) => {},
		send: async (ch, m) => {},
		grant: {
			confirmAndGrant: async (p) => {
				confirmed.push(p);
				return { ok: true, subscriptionId: 'sub_1', plan: p.plan, days: 7 };
			}
		},
		approvers: ['admin-1'],
		approverUsers: ['admin'],
		now: NOW,
		answerApproval: async (paymentId, answeredBy, answeredAt) => answers.push({ paymentId, answeredBy, answeredAt }),
		rejectPayment: async (paymentId) => rejected.push(paymentId)
	};
	const interaction = { id: 'i6', userId: 'admin', userDisplayName: 'admin', channelId: 'admin-1' };

	await handleApproval(interaction, 'yes', payment, ctx);

	assert.equal(confirmed.length, 1);
	assert.deepEqual(answers, [{ paymentId: 'pay_1', answeredBy: 'admin', answeredAt: NOW.getTime() }]);
	assert.deepEqual(rejected, []);
});

