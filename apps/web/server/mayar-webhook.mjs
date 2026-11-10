// apps/web/server/mayar-webhook.mjs — the inbound Mayar settlement route (H1).
//
// Mounted BEFORE express.json (see index.mjs) so the handler can read the raw
// body if it ever needs to — but Mayar's webhook is a HINT ONLY: it carries at
// most `event` and `data.id`/`data.transactionId`. We take exactly those two
// fields, then do the ONE authoritative thing:
//
//   GET /hl/v2/transactions/{hintedId}   (server-side re-fetch)
//
// and bind the result to OUR row by `payment.raw.mayar.transactionId` (what WE
// persisted at create), then require `status === 'paid'` AND
// `Number(tx.amount) === payment.amount_idr`. Every money decision flows
// through `confirmAndGrant` (payment-confirm.ts) → `resolveGrant` (payments.ts)
// — this file contains NO grant rule of its own.
//
// Every refusal is ACKed 200 so Mayar does not retry a body it delivered
// honestly (the same status discipline as webhook.mjs). The durable idempotency
// (one payment_id, one subscription) lives in `confirmAndGrant`, so a replay or
// a concurrent reconcile re-delivery can never mint a second grant.
//
// Fail-closed: when `MAYAR_WEBHOOK_ENABLED !== 'true'` (the default) or
// `MAYAR_API_KEY` is unset, the route answers 404 — no new surface exists until
// an operator turns it on.
//
// Middleware order (mandate #8): the enabled gate runs FIRST so an OFF route
// 404s WITHOUT consuming a rate-limit slot, then the IP rate-limit, and LAST
// express.raw — a flood is rejected by the limiter before its 64KB body is ever
// buffered/parsed. `express.raw` stays mounted here (a route list entry) rather
// than moved to a global `app.use`, so its scope never widens; it steps to the
// end of the chain so it only buffers bytes a request was allowed to reach.

import express from 'express';
import { sql } from 'drizzle-orm';

import { rateLimit } from './rate-limit.mjs';
import { clientIp } from './lib/ip.mjs';

import { MAYAR_GATEWAY, mayarWebhookEnabled, mayarClientFromEnv, MayarConfigError } from '@fudrouter/platform/server/mayar.ts';
import { MAYAR_RAW_KEY, mayarTransactionIdOf, runMayarSettlement } from '@fudrouter/platform/server/mayar-settlement.ts';
import { drizzlePaymentConfirmStore } from '@fudrouter/platform/server/payment-confirm.ts';
import { drizzleSubscriptionWriter } from '@fudrouter/platform/server/grant.ts';

/** The body is tiny (event + id); an upper bound is the DoS backstop. */
const MAYAR_WEBHOOK_BODY_LIMIT = '64kb';

/**
 * Resolve OUR `gateway='mayar'` payment by the transaction id we persisted at
 * create (H1). No status filter: `confirmAndGrant` owns the
 * one-status-one-grant idempotency, so a replay of an already-confirmed payment
 * still resolves here and reports `alreadyConfirmed` instead of minting again.
 */
async function findMayarByTransactionId(database, transactionId) {
	if (!database || !transactionId) return null;
	const found = await database.execute(sql`
		select id, gateway_ref, gateway, account_id, channel, plan,
		       amount_idr::bigint as amount_idr, status, raw
		from payment
		where gateway = ${MAYAR_GATEWAY}
		  and raw -> ${MAYAR_RAW_KEY} ->> 'transactionId' = ${transactionId}
		limit 1`);
	const list = Array.isArray(found) ? found : (found?.rows ?? []);
	const row = list[0] ?? null;
	if (!row) return null;
	return {
		id: String(row.id),
		gatewayRef: String(row.gateway_ref),
		gateway: String(row.gateway),
		accountId: String(row.account_id),
		channel: String(row.channel),
		plan: String(row.plan),
		amountIdr: Number(row.amount_idr),
		transactionId: mayarTransactionIdOf(row.raw)
	};
}

/** Extract the hinted id from the inbound body (`data.transactionId` ?? `data.id`). */
export function hintedIdOf(body) {
	if (!body || typeof body !== 'object') return '';
	const data = body.data && typeof body.data === 'object' ? body.data : {};
	if (typeof data.transactionId === 'string' && data.transactionId.trim()) return data.transactionId.trim();
	if (typeof data.id === 'string' && data.id.trim()) return data.id.trim();
	return '';
}

/** Register `POST /api/mayar/webhook`, or a 404 gate when disabled. */
export function registerMayarWebhook(app, ctx = {}) {
	const getDb = ctx.getDb ?? (() => null);
	const rawClient = ctx.getClient ?? (() => mayarClientFromEnv());
	const enabled = ctx.enabled ?? (() => mayarWebhookEnabled());
	// Test seam: the transport's only decision is "call runMayarSettlement with
	// the injected seams". A test injects this to pin the 404/200 envelope
	// without a database.
	const settle = ctx.settle ?? ((active, db, hintedId) =>
		runMayarSettlement(
			{
				getTransaction: (id) => active.getTransaction(id),
				findPendingByTransactionId: (transactionId) => findMayarByTransactionId(db, transactionId),
				store: drizzlePaymentConfirmStore(db),
				writer: drizzleSubscriptionWriter(db)
			},
			hintedId
		));

	// A config mistake (key/base environment mismatch) is never a boot crash:
	// it logs once and the route stays 404-gated, fail-closed.
	const getClient = () => {
		try {
			return rawClient();
		} catch (err) {
			if (err instanceof MayarConfigError || err?.name === 'MayarConfigError') {
				console.error('[mayar] configuration error; webhook settlement DISABLED:', err.message);
				return null;
			}
			throw err;
		}
	};

	// Fail closed with a log when the key is absent; the route gate below still 404s.
	if (!getClient()) console.warn('[mayar] MAYAR_API_KEY is not set; Mayar webhook settlement is DISABLED');

	const ipLimit =
		ctx.ipLimit ??
		rateLimit({
			windowMs: 60_000,
			max: 120,
			key: async (req) => `mayar:ip:${clientIp(req) ?? 'unknown'}`
		});

	// The enabled gate is a middleware (NOT an in-handler check) so an OFF route
	// is rejected before the rate-limiter (no slot consumed while disabled) and
	// before express.raw (no body buffered while disabled). Named so tests can
	// assert its position in the middleware chain.
	function mayarWebhookEnabledGate(req, res, next) {
		// Checked per-request (not just at registration) so a live-reload of env
		// never exposes a disabled path.
		if (!enabled()) return res.status(404).json({ error: 'Not found' });
		next();
	}

	app.post(
		'/api/mayar/webhook',
		mayarWebhookEnabledGate,
		ipLimit,
		express.raw({ type: () => true, limit: MAYAR_WEBHOOK_BODY_LIMIT }),
		async (req, res) => {
			// express.raw leaves `req.body` as a Buffer; accept the string/absent
			// shapes a test seam may hand through.
			const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : '');
			let body = null;
			try {
				body = raw ? JSON.parse(raw) : null;
			} catch {
				body = null;
			}
			const hintedId = hintedIdOf(body);
			// `event` is read only for the log line below, never for a decision.
			const event = body && typeof body.event === 'string' ? body.event : '';

			const db = getDb ? getDb() : null;
			if (!db) return res.status(503).json({ error: 'Database unavailable' });

			const active = getClient();
			if (!active) {
				// Key unset: the route is already 404-gated, but a request can only
				// get here with the gate mis-configured — never grant.
				return res.status(404).json({ error: 'Not found' });
			}

			const result = await settle(active, db, hintedId);

			if (!result.ok) {
				console.warn('[mayar] webhook not settled', { event, hintedId, reason: result.reason });
				// ACK 200: do not instruct Mayar to retry a body it already delivered.
				return res.status(200).json({ ok: true, settled: false, reason: result.reason });
			}

			return res.status(200).json({
				ok: true,
				settled: true,
				granted: result.granted,
				alreadyConfirmed: result.alreadyConfirmed,
				paymentId: result.paymentId,
				subscriptionId: result.subscriptionId
			});
		}
	);
}