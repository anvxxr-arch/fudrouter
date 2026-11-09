// apps/web/server/discord-transport.mjs — the Discord interactions transport (C2).
//
// This route owns ONLY the inbound HTTP half of the Discord payments surface:
//
//   1. Ed25519 signature verification (FLEXYROUTE_PUBLIC_KEY) — the public key
//      Discord signs the raw interaction body with. Without the key the route
//      registers NOTHING (fail-closed, logged), so a deployment without a bot
//      cannot silently accept unsigned Discord payloads.
//   2. Dispatch of an INTERACTION_CREATE onto the discord-bot.ts adapter:
//      PING -> PONG, /plans, /pay (mint QRIS), proof upload, approval button.
//   3. The seams the adapter's DiscordBotContext needs: claim (CS1), grant
//      (B3b confirmAndGrant -> drizzleSubscriptionWriter), gatewayStore (B1
//      createPayment) and approvers (approval.ts parseApprovers).
//
// Every money DECISION is the core's and only the core's: decideClaim (bots.ts),
// resolveGrant (payments.ts, through confirmAndGrant), parseApprovers
// (approval.ts), createPayment (gateway.ts). This file copies none of them — it
// only maps a Discord update onto those calls and renders the reply.
//
// The one asymmetry vs telegram-bot.ts is deliberate and documented here:
// discord-bot.ts `handlePay` only renders (returns the prompt text, no mint).
// The Telegram adapter mints inside handlePay; Discord has no queued-update id
// to key idempotency on until the interaction arrives, so THIS transport mints
// through B1's createPayment (still the one core writer, never a hand-rolled
// insert) before replying with the core `renderPay` text + QRIS.

import express from 'express';
import { createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
	handlePlans,
	handleProof,
	handleApproval,
	renderPay,
	parseApprovalCustomId
} from '@fudrouter/platform/server/discord-bot.ts';
import { parseApprovers } from '@fudrouter/platform/server/approval.ts';
import { APPROVERS_ENV, discordApproverUsers } from '@fudrouter/platform/server/approval-env.ts';
import { createPayment } from '@fudrouter/platform/server/gateway.ts';
import { drizzleGatewayStore } from '@fudrouter/platform/server/gateway-store.ts';
import {
	confirmAndGrant,
	drizzlePaymentConfirmStore
} from '@fudrouter/platform/server/payment-confirm.ts';
import { drizzleSubscriptionWriter } from '@fudrouter/platform/server/grant.ts';

// ---------------------------------------------------------------------------
// Ed25519 verification (Discord's public-key signing).
// ---------------------------------------------------------------------------

// A raw 32-byte Ed25519 public key wrapped in the fixed SPKI DER prefix. Node's
// `createPublicKey` cannot take the bare key bytes as `type:'spki'`, and the
// raw bytes are exactly what FLEXYROUTE_PUBLIC_KEY carries (hex), so the prefix
// is prepended once — the canonical way to import a raw Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Constant-time verify of a Discord interaction: the signature covers
 * `timestamp + rawBody` (Discord's documented convention). Returns false for
 * any malformed input — fail closed, never throw.
 *
 * @param {{ rawBody: string|Buffer|null|undefined,
 *           signature: string|null|undefined,
 *           timestamp: string|null|undefined,
 *           publicKeyHex: string|null|undefined }} input
 */
export function verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex }) {
	const body =
		typeof rawBody === 'string' ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : '';
	const sig = String(signature ?? '').trim();
	const ts = String(timestamp ?? '').trim();
	const hex = String(publicKeyHex ?? '').trim();
	if (!body || !sig || !ts || !hex) return false;

	// W7: Discord's signature covers timestamp+body, but a VALID signed
	// interaction (a signed approval "yes" included) could otherwise be replayed
	// without limit. Reject a timestamp older than 5 minutes (Discord's own
	// recommendation) before any key/verify work.
	const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum)) return false;
	if (Math.abs(Date.now() - tsNum * 1000) > DISCORD_SIGNATURE_MAX_AGE_MS) return false;

	const rawKey = Buffer.from(hex, 'hex');
	if (rawKey.length !== 32) return false;

	let key;
	try {
		key = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
			format: 'der',
			type: 'spki'
		});
	} catch {
		return false;
	}

	try {
		return ed25519Verify(null, Buffer.from(`${ts}${body}`), key, Buffer.from(sig, 'hex'));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Dispatch (pure over injected seams — no network, no database of its own).
// ---------------------------------------------------------------------------

const RESPONSE_TYPE = Object.freeze({ PONG: 1, CHANNEL_MESSAGE: 4 });
const INTERACTION_TYPE = Object.freeze({ PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 });

/** Normalize a raw Discord interaction into the discord-bot.ts `DiscordInteraction`. */
function normalizeInteraction(raw) {
	const userObj = (raw.member && raw.member.user) || raw.user || {};
	const data = raw.data || {};
	const isSlash = data.type === 1;
	const name = isSlash && typeof data.name === 'string' ? data.name : undefined;
	const options = Array.isArray(data.options) ? data.options : [];
	const planOption = options.find((o) => o.name === 'plan' || o.name === 'plan_id');
	const attachments = [];
	if (data.resolved && Array.isArray(data.resolved.attachments)) {
		for (const a of data.resolved.attachments) attachments.push({ url: typeof a.url === 'string' ? a.url : '' });
	}
	return {
		id: String(raw.id ?? ''),
		userId: String(userObj.id ?? ''),
		userDisplayName: String(userObj.global_name ?? userObj.username ?? ''),
		channelId: String(raw.channel_id ?? ''),
		// memberChannelId is intentionally NOT set here: a MESSAGE_COMPONENT
		// interaction only carries the channel the button was clicked in (the
		// admin channel), not the member's DM. discord-bot.ts handleApproval
		// falls back to channelId when memberChannelId is unset, so an approval
		// "no" follow-up lands in the admin channel today. Routing it to the
		// member's DM would need the member channel encoded into the approval
		// custom id — the adapter's concern, not this transport's.
		commandName: name,
		planId: planOption ? String(planOption.value ?? '') : undefined,
		attachments,
		componentId: typeof data.custom_id === 'string' ? data.custom_id : undefined
	};
}

async function handlePayCommand(interaction, botCtx, deps) {
	const planId = interaction.planId ?? '';
	const rendered = renderPay(planId); // the one core price/QR decision
	if (!rendered.ok) {
		await botCtx.reply(interaction, rendered.text);
		return;
	}
	const accountId = await deps.accountIdFor(interaction.userId);
	if (!accountId) {
		await botCtx.reply(interaction, 'Link your Discord account in the dashboard before paying.');
		return;
	}
	const mint = await createPayment(
		{ store: deps.gatewayStore },
		{
			accountId,
			channel: 'discord',
			plan: planId,
			amountIdr: rendered.amountIdr,
			idempotencyKey: `discord:${interaction.userId}:${interaction.id}`
		}
	);
	if (!mint.ok) {
		await botCtx.reply(interaction, `Could not start the payment (${mint.reason}). Please try again.`);
		return;
	}
	await botCtx.reply(interaction, `${rendered.text}\n\`\`\`\n${rendered.qris}\n\`\`\``);
}

async function handleProofCommand(interaction, botCtx, deps) {
	const accountId = await deps.accountIdFor(interaction.userId);
	if (!accountId) {
		await botCtx.reply(interaction, 'Link your Discord account in the dashboard before paying.');
		return;
	}
	const pending = await deps.findPendingPayment(accountId);
	if (!pending) {
		await botCtx.reply(interaction, 'No pending payment found. Run /pay <plan> first.');
		return;
	}
	await handleProof(interaction, botCtx, {
		planId: pending.planId,
		paymentId: pending.paymentId
	});
}

async function handleApprovalComponent(interaction, parsed, botCtx, deps) {
	const resolved = await deps.resolveClaim(parsed.paymentId);
	if (!resolved) {
		await botCtx.reply(interaction, 'Claim not found.');
		return;
	}
	await handleApproval(
		interaction,
		parsed.answer,
		{
			paymentId: parsed.paymentId,
			plan: resolved.plan,
			amountIdr: resolved.amountIdr,
			status: resolved.status ?? 'claimed'
		},
		botCtx
	);
}

/**
 * Route one verified interaction. `deps` supplies the transport seams; the
 * returned object is the Discord REST response JSON (type 4 carries the reply
 * content the adapter produced). Inject everything for tests — none of the
 * production DB/env wiring is exercised here.
 *
 * @param {object} interaction the parsed Discord interaction
 * @param {{
 *   send?: Function,
 *   grant?: { confirmAndGrant: Function },
 *   claim?: { record: Function },
 *   approvers?: string[],
 *   now?: Date,
 *   accountIdFor: Function,
 *   findPendingPayment: Function,
 *   gatewayStore: object,
 *   resolveClaim: Function
 * }} deps
 */
export async function handleDiscordInteraction(interaction, deps) {
	const type = interaction.type;

	if (type === INTERACTION_TYPE.PING) {
		return { type: RESPONSE_TYPE.PONG };
	}

	const replies = [];
	const botCtx = {
		reply: async (_i, message) => {
			replies.push(String(message));
		},
		send: deps.send ?? (async () => {}),
		grant: deps.grant,
		claim: deps.claim,
		approvers: deps.approvers ?? [],
		// C2: the actor allow-list (Discord USER ids); C3 answer/reject writers.
		approverUsers: deps.approverUsers ?? [],
		answerApproval: deps.answerApproval,
		rejectPayment: deps.rejectPayment,
		now: deps.now
	};
	const norm = normalizeInteraction(interaction);
	const data = interaction.data || {};

	if (type === INTERACTION_TYPE.APPLICATION_COMMAND && data.type === 1) {
		const name = typeof data.name === 'string' ? data.name : '';
		if (name === 'plans') {
			await handlePlans(norm, botCtx);
		} else if (name === 'pay') {
			await handlePayCommand(norm, botCtx, deps);
		} else if (name === 'proof') {
			await handleProofCommand(norm, botCtx, deps);
		} else {
			replies.push('Unknown command. Send /plans to see the plans we sell.');
		}
		return { type: RESPONSE_TYPE.CHANNEL_MESSAGE, data: { content: replies[replies.length - 1] ?? '' } };
	}

	if (type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
		const parsed = parseApprovalCustomId(data.custom_id);
		if (!parsed) {
			replies.push('Unknown interaction.');
		} else {
			await handleApprovalComponent(norm, parsed, botCtx, deps);
		}
		return { type: RESPONSE_TYPE.CHANNEL_MESSAGE, data: { content: replies[replies.length - 1] ?? '' } };
	}

	// Any other interaction type is acked empty, never guessed (fail closed).
	replies.push('Unsupported interaction type.');
	return { type: RESPONSE_TYPE.CHANNEL_MESSAGE, data: { content: replies[replies.length - 1] ?? '' } };
}

// ---------------------------------------------------------------------------
// Production seams (drizzle-backed, env-read). Only reached at runtime.
// ---------------------------------------------------------------------------

/** CS1's claim writer + C3's approval-answer writer both live in
 * packages/platform/server/claim.ts; load it lazily so this module still
 * imports while that sibling lands. */
let _claimWriterModule;
async function claimWriterFactory() {
	if (typeof _claimWriterModule === 'undefined') {
		try {
			const mod = await import('@fudrouter/platform/server/claim.ts');
			_claimWriterModule = {
				drizzleClaimWriter: typeof mod.drizzleClaimWriter === 'function' ? mod.drizzleClaimWriter : null,
				drizzleApprovalAnswerWriter:
					typeof mod.drizzleApprovalAnswerWriter === 'function' ? mod.drizzleApprovalAnswerWriter : null
			};
		} catch {
			_claimWriterModule = { drizzleClaimWriter: null, drizzleApprovalAnswerWriter: null };
		}
	}
	return _claimWriterModule;
}

async function discordAccountUserId(db, discordUserId) {
	if (!db || !discordUserId) return null;
	const found = await db.execute(
		sql`select user_id from account where account_id = ${discordUserId} and provider_id = 'discord' limit 1`
	);
	const rows = Array.isArray(found) ? found : found?.rows ?? [];
	return rows[0]?.user_id != null ? String(rows[0].user_id) : null;
}

async function discordPendingPayment(db, accountId) {
	if (!db || !accountId) return null;
	const found = await db.execute(
		sql`select id, plan from payment where account_id = ${accountId} and status = 'pending' order by created_at desc limit 1`
	);
	const rows = Array.isArray(found) ? found : found?.rows ?? [];
	const r = rows[0];
	if (!r) return null;
	return { paymentId: String(r.id), planId: String(r.plan) };
}

/** Out-of-band Discord send (admin prompt, member follow-up), best-effort. */
export async function discordSendDirect(channelId, message, token = process.env.FLEXYROUTE_BOT_TOKEN) {
	if (!token || !channelId) return;
	try {
		await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
			method: 'POST',
			headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
			// C4: disable ALL mention parsing — a member-controlled display name or
			// proof URL containing @everyone/@here (or a raw <@id>) must not ping
			// every admin on each claim. `replied_user: false` also stops the reply
			// mention when Discord treats this as a reply.
			body: JSON.stringify({
				content: message,
				allowed_mentions: { parse: [], roles: [], users: [], replied_user: false }
			}),
			signal: AbortSignal.timeout(5000)
		});
	} catch (err) {
		console.warn('[discord] send failed:', err?.message ?? err);
	}
}

/** Build the seams dispatch consumes, wired to the real DB + env. */
async function buildProductionSeams({ getDb, approvers, approverUsers, now }) {
	const db = getDb ? getDb() : null;

	const writers = await claimWriterFactory();
	const dcw = writers?.drizzleClaimWriter ?? null;
	const daw = writers?.drizzleApprovalAnswerWriter ?? null;
	const claim =
		db && dcw
			? {
					record: async (paymentId, proofUrl) => {
						const r = await dcw(db).record(paymentId, proofUrl);
						return { ok: r.ok };
					}
				}
			: undefined;

	const grant =
		db && dcw
			? {
					confirmAndGrant: async (payment) => {
						const record = await dcw(db).resolve(payment.paymentId);
						if (!record) return { ok: false, reason: 'claim_not_found' };
						const result = await confirmAndGrant(
							{ store: drizzlePaymentConfirmStore(db) },
							record,
							drizzleSubscriptionWriter(db)
						);
						if (!result.ok) return { ok: false, reason: result.reason };
						return {
							ok: true,
							subscriptionId: result.grant.subscriptionId,
							plan: result.grant.plan,
							days: result.grant.days
						};
					}
				}
			: undefined;

	// C3: WHO answered + WHEN and the "no"→reject flip — the ONE durable writer
	// both bot adapters inject (claim.ts drizzleApprovalAnswerWriter).
	const answerApproval =
		db && daw ? (paymentId, answeredBy, answeredAt) => daw(db).answer(paymentId, answeredBy, answeredAt) : undefined;
	const rejectPayment =
		db && daw ? (paymentId) => daw(db).reject(paymentId) : undefined;

	return {
		send: (channelId, message) => discordSendDirect(channelId, message),
		grant,
		claim,
		approvers: approvers(),
		// C2: the actor allow-list (Discord USER ids), fail-closed deny-all when unset.
		approverUsers: approverUsers(),
		now: now(),
		answerApproval,
		rejectPayment,
		accountIdFor: (userId) => discordAccountUserId(db, userId),
		findPendingPayment: (accountId) => discordPendingPayment(db, accountId),
		gatewayStore: drizzleGatewayStore(db),
		resolveClaim: async (paymentId) => {
			if (!db || !dcw) return null;
			return dcw(db).resolve(paymentId);
		}
	};
}

// ---------------------------------------------------------------------------
// Verify + parse + dispatch (the pure webhook-processing step).
// ---------------------------------------------------------------------------

/**
 * Verify a Discord webhook and, when valid, dispatch it. Returns an `{ status,
 * body }` result the express handler turns directly into an HTTP response. Kept
 * separate from the route so the 401/PING/command tests run without a socket.
 *
 * @param {{ rawBody: string|Buffer, signature: string, timestamp: string,
 *           publicKeyHex: string, deps: object }} params
 */
export async function processDiscordWebhook({ rawBody, signature, timestamp, publicKeyHex, deps }) {
	if (!verifyDiscordRequest({ rawBody, signature, timestamp, publicKeyHex })) {
		return { status: 401, body: { error: 'invalid request signature' } };
	}
	let interaction;
	try {
		interaction = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8'));
	} catch {
		return { status: 400, body: { error: 'invalid request body' } };
	}
	const result = await handleDiscordInteraction(interaction, deps);
	return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// Express registration (registered BEFORE express.json so the signature sees
// the exact raw bytes — the same reason webhook.mjs mounts before the parser).
// ---------------------------------------------------------------------------

function headerValue(req, name) {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v ?? '';
}

/**
 * Register `POST /api/discord/interactions`, or do nothing (and log) when
 * FLEXYROUTE_PUBLIC_KEY is absent — fail closed, never an unsigned-accept.
 *
 * @param {import('express').Express} app
 * @param {{
 *   getPublicKey?: () => string|null,
 *   getDb?: () => any,
 *   approvers?: () => string[],
 *   now?: () => Date,
 *   bodyLimit?: string|number
 * }} [ctx]
 */
export function registerDiscordInteractions(app, ctx = {}) {
	const getPublicKey = ctx.getPublicKey ?? (() => process.env.FLEXYROUTE_PUBLIC_KEY ?? null);
	const getDb = ctx.getDb ?? (() => null);
	const approvers = ctx.approvers ?? (() => parseApprovers(process.env[APPROVERS_ENV]));
	const approverUsers = ctx.approverUsers ?? discordApproverUsers;
	const now = ctx.now ?? (() => new Date());

	const publicKey = getPublicKey();
	if (!publicKey) {
		console.warn('[discord] FLEXYROUTE_PUBLIC_KEY not set; Discord interactions disabled');
		return;
	}

	const bodyLimit = ctx.bodyLimit ?? '1mb';
	app.post(
		'/api/discord/interactions',
		express.raw({ type: () => true, limit: bodyLimit }),
		async (req, res) => {
			try {
				const raw = Buffer.isBuffer(req.body)
					? req.body.toString('utf8')
					: typeof req.body === 'string'
						? req.body
						: '';
				const result = await processDiscordWebhook({
					rawBody: raw,
					signature: headerValue(req, 'x-signature-ed25519'),
					timestamp: headerValue(req, 'x-signature-timestamp'),
					publicKeyHex: publicKey,
					deps: await buildProductionSeams({ getDb, approvers, approverUsers, now })
				});
				res.status(result.status).json(result.body);
			} catch (err) {
				console.error('[discord] interactions', err);
				if (!res.headersSent) {
					res.status(500).json({ error: 'Discord interaction handling failed' });
				}
			}
		}
	);
}