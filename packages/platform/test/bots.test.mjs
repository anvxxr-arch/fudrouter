// packages/platform/test/bots.test.mjs — the four-case contract (criterion 3).
//
// Why this file exists: `decideClaim` is the one function that turns an admin's
// button press into "publish this member's key". A bug here publishes a key for
// a payment that never happened, or refuses a member who paid. Both are worse
// than a crash, so every branch is pinned: success, error, warn, unknown.
//
// Run: node --test packages/platform/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	planLines,
	formatIdr,
	paymentPrompt,
	adminApprovalPrompt,
	followUpMessage,
	warningText,
	marketplaceListing,
	decideClaim
} from '../server/bots.ts';

const NOW = new Date('2026-10-31T12:00:00Z');

// --- planLines / formatIdr --------------------------------------------------

test('planLines: success — five plans, cheapest first', () => {
	const lines = planLines();
	assert.equal(lines.length, 5);
	assert.equal(lines[0].id, 'sub_1d');
	assert.equal(lines[4].id, 'sub_28d');
});

test('formatIdr: success — rupiah uses dot thousands separators', () => {
	assert.equal(formatIdr(30000), 'Rp 30.000');
	assert.equal(formatIdr(5000), 'Rp 5.000');
});

test('formatIdr: unknown — a fractional amount rounds', () => {
	assert.equal(formatIdr(5000.6), 'Rp 5.001');
});

// --- paymentPrompt ----------------------------------------------------------

test('paymentPrompt: success — a known plan yields a QRIS and the amount', () => {
	const p = paymentPrompt('sub_7d');
	assert.ok(p);
	assert.equal(p.amountIdr, 30000);
	assert.match(p.qris, /540530000/);
	assert.match(p.text, /Rp 30\.000/);
});

test('paymentPrompt: unknown — an unknown plan yields null', () => {
	assert.equal(paymentPrompt('sub_999d'), null);
	assert.equal(paymentPrompt(''), null);
});

// --- adminApprovalPrompt ----------------------------------------------------

test('adminApprovalPrompt: success — names the member, plan and reference', () => {
	const p = adminApprovalPrompt('budi', 'sub_7d', 'https://img/x.png');
	assert.match(p.text, /budi/);
	assert.match(p.text, /Rp 30\.000/);
	assert.match(p.text, /https:\/\/img\/x\.png/);
	assert.equal(p.buttons.length, 2);
	assert.equal(p.buttons[0].id, 'yes');
	assert.equal(p.buttons[1].id, 'no');
});

test('adminApprovalPrompt: unknown — a missing reference is labelled, not blank', () => {
	const p = adminApprovalPrompt('budi', 'sub_7d', '');
	assert.match(p.text, /\(no image\)/);
});

// --- followUpMessage --------------------------------------------------------

test('followUpMessage: success — names the plan and amount', () => {
	assert.match(followUpMessage('sub_3d'), /Rp 12\.000/);
});

test('followUpMessage: unknown — an unknown plan yields a safe generic', () => {
	assert.match(followUpMessage('sub_999d'), /contact support/);
});

// --- warningText ------------------------------------------------------------

test('warningText: success — a known rule yields its message', () => {
	assert.match(warningText('ip_limit'), /3 IP addresses/);
	assert.match(warningText('concurrency'), /5 concurrent/);
});

test('warningText: unknown — an unmodelled rule yields a generic message', () => {
	assert.match(warningText('something_new'), /issue with your account/);
});

test('warningText: warn — a detail is appended', () => {
	assert.match(warningText('ip_limit', 'Seen from 4.4.4.4.'), /4\.4\.4\.4/);
});

// --- marketplaceListing -----------------------------------------------------

test('marketplaceListing: success — the five plans are listed', () => {
	const m = marketplaceListing();
	assert.equal(m.items.length, 5);
	assert.equal(m.title, 'Subscription plans');
});

// --- decideClaim (rule 21) --------------------------------------------------

test('decideClaim: success — yes on a matching payment grants and publishes', () => {
	const d = decideClaim({ plan: 'sub_7d', status: 'pending', amountIdr: 30000 }, 'yes', NOW);
	assert.equal(d.grant, true);
	assert.equal(d.publishKey, true);
	assert.equal(d.followUp, false);
	assert.equal(d.reason, 'granted');
});

test('decideClaim: error — yes on a short payment does NOT grant', () => {
	const d = decideClaim({ plan: 'sub_7d', status: 'pending', amountIdr: 1000 }, 'yes', NOW);
	assert.equal(d.grant, false);
	assert.equal(d.publishKey, false);
	assert.equal(d.followUp, true);
	assert.equal(d.reason, 'amount_mismatch');
});

test('decideClaim: warn — no follows up and never publishes', () => {
	const d = decideClaim({ plan: 'sub_7d', status: 'pending', amountIdr: 30000 }, 'no', NOW);
	assert.equal(d.grant, false);
	assert.equal(d.publishKey, false);
	assert.equal(d.followUp, true);
	assert.equal(d.reason, 'admin_declined');
});

test('decideClaim: unknown — an unrecognised answer fails closed', () => {
	for (const bad of ['maybe', '', undefined, 'YES']) {
		const d = decideClaim({ plan: 'sub_7d', status: 'pending', amountIdr: 30000 }, bad, NOW);
		assert.equal(d.grant, false, `answer ${bad} must not grant`);
		assert.equal(d.publishKey, false, `answer ${bad} must not publish`);
	}
});

test('decideClaim: unknown — an unknown plan never grants even on yes', () => {
	const d = decideClaim({ plan: 'sub_999d', status: 'pending', amountIdr: 30000 }, 'yes', NOW);
	assert.equal(d.grant, false);
	assert.equal(d.reason, 'unknown_plan');
});
