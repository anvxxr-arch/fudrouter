// apps/web/server/payment-confirm.mjs — the confirm→grant Express route (B3b).
//
// This is the TRANSPORT for packages/platform/server/payment-confirm.ts. The
// decision (idempotent payment confirm + frsubs grant, delegated to
// grantForPayment → resolveGrant) lives there and is unit-tested there; this
// file only turns an already-VERIFIED settlement into a `confirmAndGrant` call
// and maps the result to an HTTP response.
//
// The request body arrives from webhook.mjs (B3a) AFTER HMAC + anti-replay
// + settlement-code verification: `{ paymentId, gatewayRef, amountIdr, raw }`.
// Because money decisions never come from an unverified client, this route does
// NOT verify again — it forwards the verified facts. The caller proof-of-work
// (billing account lookup + subscription writer) is wired from the real
// Postgres handle through the platform bridge.
//
// No credit_purchase here (and none in payment-confirm.ts): every plan today is
// a flat subscription, and crediting prepaid balance on a flat window would
// double-pay (FR-revised §7 S3 — the S3 bug).

import { drizzlePaymentConfirmStore, confirmAndGrant } from '@fudrouter/platform/server/payment-confirm.ts';
import { drizzleSubscriptionWriter } from '@fudrouter/platform/server/grant.ts';
import { sql } from 'drizzle-orm';

/**
 * Register `POST /api/payment/confirm` under the existing Express app.
 *
 * The route takes the VERIFIED settlement (from webhook.mjs B3a) and closes the
 * loop to a subscription. Shared seams come from the platform package; the
 * Postgres handle and auth helpers are the console's own (`ctx.getDb()`).
 *
 * @param {import('express').Express} app
 * @param {{ getDb: () => any, rowsOf?: (rows:any)=>any[] }} ctx
 */
export function registerPaymentConfirm(app, ctx) {
	const { getDb } = ctx;

	app.post('/api/payment/confirm', async (req, res) => {
		const db = getDb();
		if (!db) {
			return res.status(500).json({ error: 'Database unavailable' });
		}

		const body = req.body && typeof req.body === 'object' ? req.body : {};
		const paymentId = String(body.paymentId ?? '').trim();
		const gatewayRef = String(body.gatewayRef ?? '').trim();
		const amountIdr = Number(body.amountIdr);
		const raw = body.raw;

		// A missing verified identity is not a shape we can act on.
		if (!paymentId || !gatewayRef || !Number.isFinite(amountIdr)) {
			return res.status(422).json({ error: 'Malformed confirm payload' });
		}

		// The store seam: find the payment row, because confirmAndGrant needs the
		// account/plan/channel facts that only the payment row carries.
		let row;
		try {
			const found = await db.execute(
				sql`select id, account_id, channel, gateway_ref, gateway, plan, amount_idr::bigint as amount_idr, status
					from payment where id = ${paymentId} and gateway_ref = ${gatewayRef} limit 1`
			);
			const rows = Array.isArray(found) ? found : (found?.rows ?? []);
			row = rows[0];
		} catch (err) {
			console.error('[payment-confirm] lookup failed', err);
			return res.status(500).json({ error: 'Payment lookup failed' });
		}

		if (!row) {
			return res.status(404).json({ error: 'Payment not found' });
		}

		const record = {
			id: String(row.id),
			gatewayRef: String(row.gateway_ref),
			gateway: String(row.gateway),
			accountId: String(row.account_id),
			channel: String(row.channel),
			plan: String(row.plan),
			amountIdr: amountIdr,
			raw
		};

		const result = await confirmAndGrant(
			{ store: drizzlePaymentConfirmStore(db) },
			record,
			drizzleSubscriptionWriter(db)
		);

		if (!result.ok) {
			return res.status(422).json({ error: result.reason });
		}

		return res.json({
			ok: true,
			paymentId: result.paymentId,
			paymentConfirmed: result.paymentConfirmed,
			paymentAlreadyConfirmed: result.paymentAlreadyConfirmed,
			subscriptionId: result.grant.subscriptionId,
			plan: result.grant.plan,
			days: result.grant.days,
			priceIdr: result.grant.priceIdr,
			bucket: result.grant.bucket,
			expiresAt: result.grant.expiresAt.toISOString()
		});
	});
}