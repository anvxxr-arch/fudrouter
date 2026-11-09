// packages/platform/test/discord-transport.test.mjs — the Discord interactions
// transport (C2). Pure, no network, no DATABASE_URL.
//
// What it pins:
//   1. Ed25519 signature verification — a request signed with the matching
//      private key passes; a tampered body / wrong key / wrong timestamp fails.
//   2. PING -> PONG                    — Discord's handshake is answered exactly.
//   3. bad signature -> 401            — an unsigned/forged body never reaches
//      a handler and never mints money.
//   4. command -> handler               — /plans and an approval button route to
//      discord-bot.ts with the transport seams (reply/send/grant/claim) wired;
//      no money decision is made by the transport itself.
//
// The production DB/env wiring (drizzle stores, FLEXYROUTE_BOT_TOKEN) is NOT
// exercised here: `handleDiscordInteraction` and `processDiscordWebhook` take
// everything through injected seams, so the assertions below cover the
// transport's OWN logic — verify + dispatch — and nothing else.
//
// Run: node --test packages/platform/test/discord-transport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';

import {
	handleDiscordInteraction,
	verifyDiscordRequest,
	processDiscordWebhook
} from '../../../apps/web/server/discord-transport.mjs';
import { parseApprovalCustomId } from '../server/discord-bot.ts';
import { plansMessage } from '../server/bots.ts';

// --------------------------------- fakes -----------------------------------

function makeSeams(overrides = {}) {
	const sent = [];
	const confirmed = [];
	const claimed = [];
	const seams = {
		send: async (channelId, message) => sent.push({ channelId, message }),
		grant: {
			confirmAndGrant: async (p) => {
				confirmed.push(p);
				return { ok: true, subscriptionId: 'sub_1', plan: p.plan, days: 7 };
			}
		},
		claim: {
			record: async (paymentId, proofUrl) => {
				claimed.push({ paymentId, proofUrl });
				return { ok: true };
			}
		},
		approvers: ['adm-1', 'adm-2'],
		// C2: the component interaction's actor is discord user 'u2'; the
		// fail-closed approverUsers gate must authorise THEM, else every approve
		// deny-alls. This is the seam be-platform added to the bot handler.
		approverUsers: ['u2'],
		now: new Date('2026-11-09T12:00:00Z'),
		accountIdFor: async () => 'acc_1',
		findPendingPayment: async () => ({ paymentId: 'pay_1', planId: 'sub_7d' }),
		gatewayStore: null /* unused in these assertions */,
		resolveClaim: async (paymentId) => ({
			id: paymentId,
			gatewayRef: 'purchase:x',
			gateway: 'qris-native',
			accountId: 'acc_1',
			channel: 'discord',
			plan: 'sub_7d',
			amountIdr: 30000,
			status: 'claimed'
		}),
		...overrides
	};
	return { seams, sent, confirmed, claimed };
}

function slashInteraction(name, options = []) {
	return {
		type: 2,
		data: { type: 1, name, options },
		id: 'i1',
		token: 'tok',
		member: { user: { id: 'u1', username: 'member', global_name: 'Member' } },
		channel_id: 'ch1'
	};
}

function componentInteraction(customId) {
	return {
		type: 3,
		data: { custom_id: customId },
		id: 'i2',
		token: 'tok',
		member: { user: { id: 'u2', username: 'admin', global_name: 'Admin' } },
		channel_id: 'ch2'
	};
}

// --------------------------- Ed25519 helpers -------------------------------

function freshKeypair() {
	return generateKeyPairSync('ed25519');
}

// FLEXYROUTE_PUBLIC_KEY is the raw 32-byte key as hex. Export the SPKI DER
// (44 bytes) and keep the tail 32 bytes — the raw Ed25519 public key.
function rawPublicKeyHex(publicKey) {
	const der = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
	return der.subarray(der.length - 32).toString('hex');
}

function signedRequest(body, privateKey, publicKey, timestamp = String(Math.floor(Date.now() / 1000))) {
	const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
	const signature = ed25519Sign(null, Buffer.from(`${timestamp}${rawBody}`), privateKey).toString('hex');
	return { rawBody, signature, timestamp, publicKeyHex: rawPublicKeyHex(publicKey) };
}

// ------------------------------- tests -------------------------------------

test('discord: verify true — a body signed with the matching key verifies', () => {
	const { publicKey, privateKey } = freshKeypair();
	const { rawBody, signature, timestamp, publicKeyHex } = signedRequest({ type: 1 }, privateKey, publicKey);
	assert.equal(verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex }), true);
});

test('discord: verify false — a tampered body / wrong key / wrong timestamp fails', () => {
	const { publicKey, privateKey } = freshKeypair();
	const { rawBody, signature, timestamp, publicKeyHex } = signedRequest({ type: 1 }, privateKey, publicKey);

	// Tampered body.
	assert.equal(verifyDiscordRequest({ rawBody: rawBody + 'x', signature, timestamp, publicKeyHex }), false);

	// Wrong public key (a second keypair).
	const other = freshKeypair();
	assert.equal(
		verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex: rawPublicKeyHex(other.publicKey) }),
		false
	);

	// Wrong timestamp (the signed content no longer matches).
	assert.equal(verifyDiscordRequest({ rawBody, signature, timestamp: '1700000001', publicKeyHex }), false);

	// W7: a correctly-signed but STALE timestamp (older than 5 minutes) is a replay -> false.
	const stale = signedRequest({ type: 1 }, privateKey, publicKey, String(Math.floor(Date.now() / 1000) - 600));
	assert.equal(
		verifyDiscordRequest({ rawBody: stale.rawBody, signature: stale.signature, timestamp: stale.timestamp, publicKeyHex: stale.publicKeyHex }),
		false
	);

	// Missing/blank fields fail closed, never throwing.
	assert.equal(verifyDiscordRequest({ rawBody: '', signature, timestamp, publicKeyHex }), false);
	assert.equal(verifyDiscordRequest({ rawBody, signature: '', timestamp, publicKeyHex }), false);
	assert.equal(verifyDiscordRequest({ rawBody, signature, timestamp: '', publicKeyHex }), false);
	assert.equal(verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex: '' }), false);
	assert.equal(verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex: 'zz' }), false);
});

test('discord: PING -> PONG', async () => {
	const { seams } = makeSeams();
	const out = await handleDiscordInteraction({ type: 1 }, seams);
	assert.deepEqual(out, { type: 1 });
});

test('discord: bad signature -> 401, no handler runs', async () => {
	const { seams, confirmed } = makeSeams();
	const { publicKey, privateKey } = freshKeypair();
	const signed = signedRequest({ type: 1 }, privateKey, publicKey);

	const res = await processDiscordWebhook({
		rawBody: signed.rawBody + 'x', // tampered
		signature: signed.signature,
		timestamp: signed.timestamp,
		publicKeyHex: signed.publicKeyHex,
		deps: seams
	});

	assert.equal(res.status, 401);
	assert.deepEqual(res.body, { error: 'invalid request signature' });
	assert.equal(confirmed.length, 0, 'a forged body must not invoke the grant seam');
});

test('discord: /plans command routes to the adapter and renders the core listing', async () => {
	const { seams } = makeSeams();
	const out = await handleDiscordInteraction(slashInteraction('plans'), seams);

	assert.equal(out.type, 4);
	// discordHandlePlans renders plansMessage() — proof the adapter was reached,
	// and that the transport copied NO pricing.
	assert.equal(out.data.content, plansMessage());
});

test('discord: /pay command mints a pending payment through the B1 gatewayStore', async () => {
	const created = [];
	const gatewayStore = {
		findPayment: async () => null,
		insertPayment: async (p) => { created.push(p); return { id: 'pay_1', ...p }; }
	};
	const { seams } = makeSeams({ gatewayStore, accountIdFor: async () => 'acc_1' });

	const out = await handleDiscordInteraction(
		slashInteraction('pay', [{ name: 'plan', value: 'sub_7d' }]),
		seams
	);

	// The ONE core createPayment minted exactly one pending payment (channel discord).
	assert.equal(created.length, 1);
	assert.equal(created[0].channel, 'discord');
	assert.equal(created[0].plan, 'sub_7d');
	assert.equal(created[0].amountIdr, 30000);
	// The reply carries the core renderPay text + the injected QRIS.
	assert.equal(out.type, 4);
	assert.ok(out.data.content.includes('Rp 30.000'), 'reply must carry the core amount');
});

test('discord: proof command records the claim and prompts the admin', async () => {
	const { seams, claimed, sent } = makeSeams();
	const out = await handleDiscordInteraction(slashInteraction('proof'), seams);

	assert.equal(claimed.length, 1, 'the CS1 claim seam must record once');
	assert.equal(claimed[0].paymentId, 'pay_1');
	assert.ok(sent.length > 0, 'the admin approver must receive the prompt');
	assert.match(out.data.content, /Proof received/);
});

test('discord: approval button yes routes to handleApproval and grants once', async () => {
	const { seams, confirmed } = makeSeams();
	const customId = 'approval:yes:pay_1';

	// The custom id decodes to the expected answer/payment before dispatch.
	assert.deepEqual(parseApprovalCustomId(customId), { answer: 'yes', paymentId: 'pay_1' });

	const out = await handleDiscordInteraction(componentInteraction(customId), seams);

	assert.equal(confirmed.length, 1);
	assert.equal(confirmed[0].paymentId, 'pay_1');
	assert.equal(confirmed[0].plan, 'sub_7d');
	assert.equal(confirmed[0].amountIdr, 30000);

	assert.equal(out.type, 4);
	assert.match(out.data.content, /Approved/);
	assert.match(out.data.content, /7 days/);
});

test('discord: approval button no follows up and never grants', async () => {
	const { seams, confirmed, sent } = makeSeams();
	const out = await handleDiscordInteraction(componentInteraction('approval:no:pay_1'), seams);

	assert.equal(confirmed.length, 0, 'no must never invoke the grant seam');
	assert.equal(out.type, 4);
	assert.match(out.data.content, /Not approved/);
	assert.ok(sent.length > 0, 'the member follow-up must be delivered out-of-band');
	assert.match(sent[0].message, /could not confirm/);
});

test('discord: unknown slash command answers the shared unknown-plan text', async () => {
	const { seams } = makeSeams();
	const out = await handleDiscordInteraction(slashInteraction('bogus'), seams);
	assert.equal(out.type, 4);
	assert.match(out.data.content, /Unknown command/);
});

test('discord: a non-approver actor is refused by the transport seam (C2)', async () => {
	const { seams, confirmed } = makeSeams({ approverUsers: [] /* empty => deny-all */ });
	const out = await handleDiscordInteraction(componentInteraction('approval:yes:pay_1'), seams);

	assert.equal(confirmed.length, 0, 'a non-approver must never reach the grant seam');
	assert.equal(out.type, 4);
	assert.match(out.data.content, /not an approver/i);
});

test('discord: unknown component custom-id is answered, never granted', async () => {
	const { seams, confirmed } = makeSeams();
	const out = await handleDiscordInteraction(componentInteraction('not-ours'), seams);
	assert.equal(confirmed.length, 0);
	assert.equal(out.type, 4);
	assert.match(out.data.content, /Unknown/);
});