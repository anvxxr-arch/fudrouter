// apps/web/server/webhook.mjs — the inbound gateway callback route (B3a).
//
// Mounted BEFORE express.json (see index.mjs) so the handler sees the EXACT raw
// bytes the HMAC was computed over — the classic webhook bug is letting a JSON
// reparse canonicalize the body and then comparing a signature over different
// bytes. The route owns ONLY the inbound transport half:
//
//   read raw body → verify (HMAC, freshness, settled code) → guard the optional
//   validate-back URL (SSRF) → claim the nonce (anti-replay) → find the payment
//   row by gateway_ref → forward the confirmed facts into B3b's confirm→grant
//   loop.
//
// It contains NO grant decision of its own: the money rule is
// `grantForPayment` → `resolveGrant` (payments.ts), reached through B3b's
// `confirmAndGrant`. The only SQL here is the minimal `gateway_ref → payment.id`
// discovery the settlement must do — everything else is B3b's.
//
// Status mapping (see packages/platform/server/webhook-receiver.ts
// `httpStatusForReject`): a forged/unsigned body is 401, a stale/replayed nonce
// is 409, a malformed body is 400, a genuine-but-not-settled body is ACKed 200
// so the gateway does not retry a body it already delivered honestly.

import express from 'express';
import { sql } from 'drizzle-orm';

import {
	INBOUND_SIGNATURE_HEADER,
	verifyInbound,
	claimDelivery,
	assertInboundPublic,
	httpStatusForReject,
	_vk,
	_assertPublic
} from './lib/platform-ts.mjs';

// B3b cross-file dependency: the confirm→grant loop and its drizzle seams. This
// route calls them directly rather than re-implementing a single line of the
// money rule — one payment row, one frsubs window, one `payment_already_confirmed`.
import { confirmAndGrant, drizzlePaymentConfirmStore } from '@fudrouter/platform/server/payment-confirm.ts';
import { drizzleSubscriptionWriter } from '@fudrouter/platform/server/grant.ts';

/** Upper bound on a callback payload. The HMAC body is a tiny JSON envelope. */
const WEBHOOK_BODY_LIMIT = '64kb';
/** The anti-replay window; mirror of gateway.ts GATEWAY_REPLAY_WINDOW_MS (5 min). */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * The shared gateway HMAC secret in its S0 AES-GCM envelope (credentials.ts
 * encryptCredentials output). Deliberately operator-held in env, not a table:
 * there is no `gateway` row yet, and a secret that lives in env survives a
 * vendor swap without a migration. Absent → the route answers 401 (bad_signature), fail-closed,
 * never 200, so a silent unsigned-accept cannot happen.
 */
function gatewaySecretEnc() {
	return process.env.GATEWAY_WEBHOOK_SECRET_ENC ?? null;
}

/**
 * Anti-replay nonce harness. Valkey `SET NX PX` is the atomic claim (first
 * sighting wins, auto-expires at the replay window) across every PM2 worker;
 * when Valkey is unset/`_vk()` is null it falls back to the in-process map below
 * (single-instance, bounded — the same documented assumption as rate-limit.mjs).
 *
 * This is the fast anti-replay gate, NOT the durable idempotency: the durable
 * "one gateway_ref = one grant" stopper is `payment`'s UNIQUE (gateway,
 * gateway_ref) index (0025) + `subscription_payment_id_uniq` (0038), enforced by
 * B3b's confirmAndGrant. A replay that slips past this gate (a dead Valkey)
 * still cannot mint a second grant.
 */
const _nonceFallback = new Map();
async function claimNonce(nonce, ttlMs) {
	const r = _vk();
	if (r) {
		try {
			// NX: see vk.ts's INCR/PEXPIRE-NX note — the claim must never overwrite
			// a prior in-window claim, and PX pairs the TTL with the first SET.
			const res = await r.set(`gwcb:nonce:${nonce}`, '1', 'PX', Math.max(1, ttlMs), 'NX');
			if (res === 'OK') return true;
			if (res === null) return false; // already claimed in-window
		} catch {
			// Degrade open (repo policy): fall through to the in-process store.
		}
	}
	const now = Date.now();
	const cur = _nonceFallback.get(nonce);
	if (cur && now < cur.exp) return false;
	_nonceFallback.set(nonce, { exp: now + Math.max(1, ttlMs) });
	for (const [k, v] of _nonceFallback) if (now >= v.exp) _nonceFallback.delete(k);
	return true;
}

/** The gateway_ref → payment row discovery (the settlement's idempotency link). */
async function findPaymentByGatewayRef(database, gatewayRef) {
	const found = await database.execute(
		sql`
			select id, gateway_ref, gateway, account_id, channel, plan,
			       amount_idr::bigint as amount_idr, status
			from payment
			where gateway_ref = ${gatewayRef}
			limit 1`
	);
	const rows = Array.isArray(found) ? found : (found?.rows ?? []);
	return rows[0] ?? null;
}

/**
 * Register the inbound gateway callback route.
 *
 * @param {import('express').Express} app
 * @param {{ getDb: () => any, getSecretEnc?: () => string|null }} ctx
 */
export function registerInboundWebhook(app, ctx = {}) {
	const getSecretEnc = ctx.getSecretEnc ?? gatewaySecretEnc;
	const getDb = ctx.getDb;

	// express.raw BEFORE the route: it buffers the body into a Buffer so the HMAC
	// sees the exact bytes; `type: () => true` means "any content-type".
	app.post(
		'/api/webhook/payment',
		express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
		async (req, res) => {
			try {
				const rawBuffer = Buffer.isBuffer(req.body) ? req.body : null;
				const raw = rawBuffer ? rawBuffer.toString('utf8') : typeof req.body === 'string' ? req.body : '';

				const header = req.headers[INBOUND_SIGNATURE_HEADER];
				const headerValue = Array.isArray(header) ? header[0] : header;

				const verified = await verifyInbound(
					{ secretEnc: getSecretEnc() },
					raw,
					{ [INBOUND_SIGNATURE_HEADER]: headerValue }
				);
				if (!verified.ok) {
					return res.status(httpStatusForReject(verified.reason)).json({
						error: { code: inboundErrorCode(verified.reason), message: verified.reason }
					});
				}

				// Outbound SSRF: only when the gateway asks for a validate-back URL.
				// The guard (assertPublicUpstream in ssrf.ts) is the decision; the
				// route NEVER dials it itself.
				if (verified.verifyUrl) {
					const guard = await assertInboundPublic(
						{ assertPublic: (url) => _assertPublic(url, false) },
						verified.verifyUrl
					);
					if (!guard.ok) {
						return res.status(400).json({
							error: { code: 'WEBHOOK_VERIFY_URL_BLOCKED', message: guard.reason }
						});
					}
				}

				const db = getDb ? getDb() : null;
				if (!db) {
					return res.status(503).json({
						error: { code: 'WEBHOOK_NO_DB', message: 'Database unavailable' }
					});
				}

				// Discover the payment the settlement links to. The internal id and
				// the account/plan facts come from this row, never from the callback
				// body — the gateway echoes only our `ref`.
				let row;
				try {
					row = await findPaymentByGatewayRef(db, verified.gatewayRef);
				} catch (err) {
					console.error('[webhook] payment lookup failed', err);
					return res.status(500).json({
						error: { code: 'WEBHOOK_LOOKUP_FAILED', message: 'Payment lookup failed' }
					});
				}
				if (!row) {
					return res.status(404).json({
						error: { code: 'WEBHOOK_UNKNOWN_REF', message: 'unknown_ref' }
					});
				}

				const alreadyConfirmed = String(row.status) === 'confirmed';

				// Anti-replay claim. `delivery.seen` = "the durable idempotency anchor
				// already recorded this settlement", so a redelivery of an
				// already-confirmed ref is an ACK that mints nothing, while a reused
				// nonce on a NOT-yet-confirmed ref is a hard replay refusal.
				const claim = await claimDelivery(
					{ nonces: { claim: claimNonce }, delivery: { seen: async () => alreadyConfirmed } },
					verified.gatewayRef,
					verified.nonce,
					REPLAY_WINDOW_MS
				);
				if (!claim.ok) {
					return res.status(httpStatusForReject(claim.reason)).json({
						error: { code: inboundErrorCode(claim.reason), message: claim.reason }
					});
				}
				if (claim.state === 'existing') {
					return res.status(200).json({ ok: true, already: true, subscriptionId: null });
				}

				// B3b cross-file dependency: confirm the payment and grant the frsubs
				// window. `amountIdr` is the VERIFIED gateway amount; the plan-price
				// check lives in `confirmAndGrant` → `resolveGrant`, not here.
				const record = {
					id: String(row.id),
					gatewayRef: String(row.gateway_ref),
					gateway: String(row.gateway),
					accountId: String(row.account_id),
					channel: String(row.channel),
					plan: String(row.plan),
					amountIdr: verified.amountIdr,
					raw: parseBodyObject(raw)
				};

				const result = await confirmAndGrant(
					{ store: drizzlePaymentConfirmStore(db) },
					record,
					drizzleSubscriptionWriter(db)
				);

				if (!result.ok) {
					return res.status(confirmErrorStatus(result.reason)).json({
						error: { code: 'WEBHOOK_CONFIRM_REJECTED', message: result.reason }
					});
				}

				return res.status(200).json({
					ok: true,
					already: result.paymentAlreadyConfirmed,
					paymentId: result.paymentId,
					subscriptionId: result.grant.subscriptionId
				});
			} catch (err) {
				console.error('[webhook] inbound', err);
				if (!res.headersSent) {
					return res.status(500).json({
						error: { code: 'WEBHOOK_INTERNAL', message: 'Webhook processing failed' }
					});
				}
			}
		}
	);
}

/** Parse a already-HMAC-verified raw body back into its object (for `raw` jsonb). */
function parseBodyObject(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function inboundErrorCode(reason) {
	const map = {
		bad_signature: 'WEBHOOK_BAD_SIGNATURE',
		stale_timestamp: 'WEBHOOK_STALE_TIMESTAMP',
		replay: 'WEBHOOK_REPLAY',
		not_settled: 'WEBHOOK_NOT_SETTLED',
		bad_body: 'WEBHOOK_BAD_BODY',
		missing_ref: 'WEBHOOK_MISSING_REF',
		missing_nonce: 'WEBHOOK_MISSING_NONCE',
		bad_timestamp: 'WEBHOOK_BAD_TIMESTAMP',
		missing_amount: 'WEBHOOK_MISSING_AMOUNT'
	};
	return map[reason] ?? 'WEBHOOK_REJECTED';
}

function confirmErrorStatus(reason) {
	// A settlement we verified but cannot turn into a window (amount/plan) is an
	// unprocessable business state; a ref with no payment id is unknown.
	if (reason === 'no_payment_id' || reason === 'unknown_ref') return 404;
	return 422;
}