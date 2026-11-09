// apps/web/server/telegram-transport.mjs — the Telegram webhook transport (CS3).
//
// This is the TRANSPORT half of the Telegram bots feature (owner rules 3, 4,
// 16, 17, 21). It owns ONLY the Telegram-shaped inbound I/O:
//
//   read the update → verify the webhook secret token → normalise the update
//   into a message or callback query → dispatch it into the shared handlers
//   (packages/platform/server/telegram-bot.ts), which own every DECISION by
//   delegating to bots.ts / payments.ts / payment-confirm.ts / grant.ts.
//
// It contains NO money decision of its own: no price, no plan, no grant, no
// claim write. The claim seams (recordClaim/resolveClaim) are wired to CS1's
// `drizzleClaimWriter`; the confirm→grant loop is B3b's
// `drizzlePaymentConfirmStore` + B2's `drizzleSubscriptionWriter`; the pending
// payment is minted through B1's `createPayment`, which this file only supplies
// a GatewayStore seam for.
//
// Verification is the secret-token header Telegram sets on every delivery. It is
// NOT the full body HMAC the gateway receiver uses (that is B3a's market); a
// Telegram bot cannot sign a body, so the operator-held `TELEGRAM_WEBHOOK_SECRET`
// is the thing that proves a request came from Telegram's delivery servers.
// Absent secret → the endpoint is DISABLED (404, logged once at registration),
// never a crash and never a silent unsigned-accept.

import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
	handleMessage,
	handleCallbackQuery,
	parseApprovers,
	APPROVERS_ENV,
	drizzleClaimWriter,
	newId
} from './lib/platform-ts.mjs';
import { drizzlePaymentConfirmStore } from '@fudrouter/platform/server/payment-confirm.ts';
import { drizzleGatewayStore } from '@fudrouter/platform/server/gateway-store.ts';
import { drizzleSubscriptionWriter } from '@fudrouter/platform/server/grant.ts';

/** Header Telegram sets on every webhook delivery when a secret token is set. */
export const TELEGRAM_SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';
/** The register/dispatch env gate: absent → endpoint disabled (fail closed). */
export const TELEGRAM_WEBHOOK_SECRET_ENV = 'TELEGRAM_WEBHOOK_SECRET';
/** The bot token used for OUTBOUND sendMessage/answerCallbackQuery. */
export const TELEGRAM_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';

const TELEGRAM_API = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// pure helpers (exported so the test pins them directly)
// ---------------------------------------------------------------------------

/** Constant-time compare of the secret-token header against the expected value. */
export function verifySecretToken(headerValue, expected) {
	if (typeof headerValue !== 'string' || typeof expected !== 'string') return false;
	if (!expected) return false;
	const a = Buffer.from(headerValue.trim());
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Encode the admin Yes/No answer plus its claim into a callback button's
 * `callback_data` string. The claim is untrusted transport-encoded display
 * facts (paymentId is the idempotency anchor re-fetched by `resolveClaim`);
 * `memberName` is carried only so a follow-up can keep referring to the member.
 */
export function encodeCallbackData(answer, claim) {
	return JSON.stringify({ a: answer, p: claim?.paymentId, c: claim?.memberChatId, n: claim?.memberName ?? '' });
}

/**
 * Decode a callback button's `callback_data` back into `{ answer, claim }`, or
 * null when it is not one of ours / malformed (fail closed: an unknown button
 * is answered with "Unknown action", never treated as a grant).
 */
export function decodeCallbackData(data) {
	if (typeof data !== 'string' || data.trim() === '') return null;
	try {
		const v = JSON.parse(data);
		const answer = v?.a;
		const paymentId = v?.p;
		if (answer !== 'yes' && answer !== 'no') return null;
		if (typeof paymentId !== 'string' || paymentId.trim() === '') return null;
		return {
			answer,
			claim: {
				paymentId,
				memberChatId: String(v?.c ?? ''),
				memberName: String(v?.n ?? '')
			}
		};
	} catch {
		return null;
	}
}

/** Normalise a Telegram `message` update into the adapter's TelegramMessage. */
export function normalizeMessage(updateId, m) {
	const chatId = m?.chat?.id != null ? String(m.chat.id) : '';
	const username =
		typeof m?.from?.username === 'string' && m.from.username ? `@${m.from.username}` : undefined;
	const text = typeof m?.text === 'string' ? m.text : undefined;
	const photo =
		Array.isArray(m?.photo) && m.photo.length > 0
			? { fileId: String(m.photo[m.photo.length - 1].file_id ?? '') }
			: undefined;
	return { chatId, username, updateId: Number(updateId) || 0, text, photo };
}

// ---------------------------------------------------------------------------
// outbound Telegram sends (the transport's own I/O; bot token lives in env)
// ---------------------------------------------------------------------------

async function telegramApi(token, method, payload) {
	const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		throw new Error(`telegram ${method} answered ${res.status}`);
	}
	return res;
}

export function makeSend(tokenGetter, log) {
	return async (chatId, text, opts) => {
		const token = tokenGetter();
		if (!token) {
			log?.warn?.('[telegram] TELEGRAM_BOT_TOKEN is not set; outbound send skipped');
			return;
		}
		const payload = { chat_id: chatId, text };
		if (opts?.buttons?.length) {
			payload.reply_markup = {
				inline_keyboard: opts.buttons.map((b) => [
					{ text: b.label, callback_data: encodeCallbackData(b.id, opts.claim) }
				])
			};
		}
		// `opts.qris` is intentionally not rendered: this transport sends text,
		// and the prompt text already states the amount. Emitting a QR image is
		// out of scope (needs a QR renderer) — the live-bot note lists it as
		// operator setup pending.
		await telegramApi(token, 'sendMessage', payload);
	};
}

function makeAnswerCallback(tokenGetter, log) {
	return async (callbackId, text) => {
		const token = tokenGetter();
		if (!token) {
			log?.warn?.('[telegram] TELEGRAM_BOT_TOKEN is not set; outbound ack skipped');
			return;
		}
		await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callbackId, text });
	};
}

// ---------------------------------------------------------------------------
// durable seams (raw SQL so real columns work regardless of the minimal drizzle
// copies in index.mjs; the same pattern webhook.mjs / payment-confirm.mjs use)
// ---------------------------------------------------------------------------

function rowsOf(r) {
	return Array.isArray(r) ? r : r && Array.isArray(r.rows) ? r.rows : [];
}

function accountIdForTelegram(db, chatId) {
	// Telegram login (better-auth, index.mjs) stores the member's Telegram user
	// id in account.account_id with provider_id='telegram'; the Telegram user id
	// is also the private-chat id with the bot. Until that row exists (it needs
	// TELEGRAM_BOT_TOKEN + a real login), this returns null and the handler
	// tells the member to link their account in the dashboard.
	if (!db) return Promise.resolve(null);
	return (async () => {
		const rows = rowsOf(
			await db.execute(
				sql`select user_id from account where provider_id = 'telegram' and account_id = ${chatId} limit 1`
			)
		);
		const r = rows[0];
		return r ? String(r.user_id) : null;
	})();
}

function findPendingPayment(db, accountId) {
	if (!db) return Promise.resolve(null);
	return (async () => {
		const rows = rowsOf(
			await db.execute(
				sql`select id, plan from payment where account_id = ${accountId} and status = 'pending' order by created_at desc limit 1`
			)
		);
		const r = rows[0];
		return r ? { paymentId: String(r.id), planId: String(r.plan) } : null;
	})();
}

// ---------------------------------------------------------------------------
// deps + dispatch
// ---------------------------------------------------------------------------

function defaultApprovers() {
	return parseApprovers(process.env[APPROVERS_ENV]);
}

/** Build the adapter's TelegramBotDeps from ctx overrides + the real durable seams. */
function buildDeps(opts, db) {
	const idfn = opts.newId ?? newId;
	const claimWriter = opts.claimWriter ?? (db ? drizzleClaimWriter(db) : null);
	const recordClaim =
		opts.recordClaim ??
		(claimWriter
			? (args) => claimWriter.record(args.paymentId, args.proofUrl)
			: () => Promise.resolve({ ok: false, reason: 'no_claim_writer' }));
	const resolveClaim =
		opts.resolveClaim ?? (claimWriter ? (paymentId) => claimWriter.resolve(paymentId) : () => Promise.resolve(null));
	const tokenGetter = opts.botToken ?? (() => process.env[TELEGRAM_BOT_TOKEN_ENV] ?? null);
	return {
		send: opts.send ?? makeSend(tokenGetter, opts.log),
		answerCallback: opts.answerCallback ?? makeAnswerCallback(tokenGetter, opts.log),
		approvers: opts.approvers ?? defaultApprovers(),
		now: opts.now,
		accountIdFor: opts.accountIdFor ?? ((chatId) => accountIdForTelegram(db, chatId)),
		findPendingPayment: opts.findPendingPayment ?? ((accountId) => findPendingPayment(db, accountId)),
		recordClaim,
		resolveClaim,
		gatewayStore: opts.gatewayStore ?? (db ? drizzleGatewayStore(db, idfn) : null),
		paymentConfirmStore: opts.paymentConfirmStore ?? (db ? drizzlePaymentConfirmStore(db) : null),
		subscriptionWriter: opts.subscriptionWriter ?? (db ? drizzleSubscriptionWriter(db) : null)
	};
}

/**
 * Dispatch one Telegram update into the shared handlers. A `callback_query` is
 * decoded + handed to `handleCallbackQuery`; a `message` is normalised + handed
 * to `handleMessage`. Anything else is ignored (no reply, no crash).
 */
export async function dispatchUpdate(handlers, deps, update) {
	if (update && typeof update === 'object' && update.callback_query) {
		const cq = update.callback_query;
		const decoded = decodeCallbackData(cq.data);
		if (!decoded) {
			await deps.answerCallback(String(cq.id ?? ''), 'Unknown action');
			return { kind: 'unknown', reason: 'bad_callback_data' };
		}
		const result = await handlers.handleCallbackQuery(deps, {
			id: String(cq.id ?? ''),
			data: String(cq.data ?? ''),
			answer: decoded.answer,
			claim: decoded.claim
		});
		return result;
	}
	if (update && typeof update === 'object' && update.message) {
		await handlers.handleMessage(deps, normalizeMessage(update.update_id, update.message));
		return { kind: 'message' };
	}
	return { kind: 'ignored' };
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

/**
 * The webhook request handler (exported so the test can exercise it with fake
 * req/res and fakes for the seams). Verifies the secret token, then dispatches.
 *
 * @param {{ body?: any, headers?: Record<string, string|string[]> }} req
 * @param {{ status:(c:number)=>any, json:(o:any)=>any, headersSent?: boolean }} res
 * @param {object} opts — ctx overrides (getSecret, getDb, handlers, seams, log).
 */
export async function handleTelegramWebhook(req, res, opts = {}) {
	const log = opts.log ?? console;
	const getSecret = opts.getSecret ?? (() => null);
	const secret = getSecret();

	// Disabled: no operator secret configured. 404 so a crawler/scanner cannot
	// distinguish "not yours" from "here but misconfigured", and no crash.
	if (!secret) {
		return res.status(404).json({
			error: { code: 'TELEGRAM_DISABLED', message: 'Telegram webhook is not configured' }
		});
	}

	const header = req.headers?.[TELEGRAM_SECRET_TOKEN_HEADER];
	const headerValue = Array.isArray(header) ? header[0] : header;
	if (!verifySecretToken(headerValue, secret)) {
		return res.status(401).json({
			error: { code: 'TELEGRAM_BAD_SECRET', message: 'Invalid Telegram secret token' }
		});
	}

	const update = req.body && typeof req.body === 'object' ? req.body : {};
	const db = opts.getDb ? opts.getDb() : null;
	const deps = buildDeps(opts, db);
	const handlers = {
		handleMessage: opts.handleMessage ?? handleMessage,
		handleCallbackQuery: opts.handleCallbackQuery ?? handleCallbackQuery
	};

	try {
		const result = await dispatchUpdate(handlers, deps, update);
		return res.json({ ok: true, result });
	} catch (err) {
		log.error?.('[telegram] update dispatch failed', err);
		if (!res.headersSent) {
			return res.status(500).json({
				error: { code: 'TELEGRAM_DISPATCH_FAILED', message: 'Failed to process Telegram update' }
			});
		}
	}
}

/**
 * Register `POST /api/telegram/webhook`.
 *
 * The body is parsed by index.mjs's global `express.json` (this route is
 * registered after it, exactly like registerPaymentConfirm), so no local
 * body parser is needed — the secret token travels in a header, not the body.
 *
 * @param {import('express').Express} app
 * @param {{ getDb?: () => any, getSecret?: () => string|null, newId?: (p:string)=>string, log?: any } & object} ctx
 */
export function registerTelegramWebhook(app, ctx = {}) {
	const getSecret = ctx.getSecret ?? (() => process.env[TELEGRAM_WEBHOOK_SECRET_ENV] ?? null);
	const log = ctx.log ?? console;
	if (!getSecret()) {
		log.warn?.('[telegram] TELEGRAM_WEBHOOK_SECRET is not set; Telegram webhook is DISABLED');
	}

	app.post('/api/telegram/webhook', (req, res) =>
		handleTelegramWebhook(req, res, { ...ctx, getSecret, log })
	);
}