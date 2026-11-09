// packages/platform/server/claim.ts — the durable claim writer (CS1).
//
// This module owns the WRITE half of a member's payment-proof upload: it turns
// `(paymentId, proofUrl)` into the payment.status transition `pending → claimed`
// and nothing else. It is the SEAM both bot adapters (telegram-bot.ts,
// discord-bot.ts) and the transports inject, so the claim write has exactly one
// implementation. The web checkout (apps/web/server/pages.mjs) now calls this
// writer too — there is no second writer.
//
// Idempotency is the writer's whole point. The durable UPDATE is a
// compare-and-swap on `status = 'pending'`: only a pending row flips to
// 'claimed'. A replayed claim (the member re-sends the proof, or two transports
// race the same payment) must NOT flip a 'confirmed' row back to 'claimed' and
// must NOT mint a double write — it comes back `{ ok: false, reason:
// 'already_claimed' }`. The sentinel `status = 'pending'` Englishs the B3
// lifecycle: a confirmed/claimed row is already past "claim", so a claim on it
// is a distinct refusal, never a second row.
//
// Core ≠ transport: `drizzleClaimWriter` is the ONLY thing that knows Postgres;
// the module is constructed over the injected `DbTx` (same shared handle type as
// payment-confirm.ts and grant.ts), so the pure four-case test runs against an
// in-memory stand-in with no database and no DATABASE_URL.

import { eq, sql } from 'drizzle-orm';

import { payment } from './db/schema.ts';
import type { PaymentConfirmRecord } from './payment-confirm.ts';
import type { DbTx } from './audit.ts';

/** The persist seam the bot adapters inject: record a claim, resolve it back. */
export interface ClaimWriter {
	/**
	 * Persist the member's proof, flipping the payment ONLY from 'pending' to
	 * 'claimed'. Idempotent: a row already 'claimed' or 'confirmed' returns
	 * `{ ok: false, reason: 'already_claimed' }` — never a double write, never a
	 * downgrade of a confirmed payment.
	 */
	record(paymentId: string, proofUrl: string): Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Re-fetch the payment row behind a claim id (trusted store), or null when gone. */
	resolve(paymentId: string): Promise<PaymentConfirmRecord | null>;
}

/**
 * The drizzle-backed claim writer. `raw` mirrors the web checkout's
 * `{ proofUrl }` jsonb shape so a claim recorded from Telegram/Discord and one
 * recorded from the dashboard are byte-equivalent in the dispute trail.
 */
export function drizzleClaimWriter(db: DbTx): ClaimWriter {
	return {
		async record(paymentId, proofUrl) {
			if (typeof paymentId !== 'string' || paymentId.trim() === '') {
				return { ok: false, reason: 'not_found' };
			}

			// Single compare-and-swap UPDATE: only a `pending` row flips. The
			// 'claimed'/'confirmed' sentinel makes a replay the same shape as a
			// missing row at the UPDATE level, so we disambiguate below.
			const flipped = await db
				.update(payment)
				.set({
					status: 'claimed',
					raw: { proofUrl } as Record<string, unknown>,
					updatedAt: new Date()
				})
				.where(sql`${payment.id} = ${paymentId} and ${payment.status} = 'pending'`)
				.returning({ id: payment.id });

			if (flipped.length > 0) {
				return { ok: true };
			}

			// The UPDATE matched nothing: either the payment does not exist, or it
			// has already left 'pending' (claimed/confirmed). Report the distinct
			// reason rather than calling both "already_claimed".
			const rows = await db
				.select({ status: payment.status })
				.from(payment)
				.where(eq(payment.id, paymentId))
				.limit(1);
			if (rows.length === 0) {
				return { ok: false, reason: 'not_found' };
			}
			return { ok: false, reason: 'already_claimed' };
		},

		async resolve(paymentId) {
			if (typeof paymentId !== 'string' || paymentId.trim() === '') {
				return null;
			}
			const rows = await db
				.select({
					id: payment.id,
					accountId: payment.accountId,
					channel: payment.channel,
					gatewayRef: payment.gatewayRef,
					gateway: payment.gateway,
					plan: payment.plan,
					amountIdr: payment.amountIdr,
					raw: payment.raw
				})
				.from(payment)
				.where(eq(payment.id, paymentId))
				.limit(1);
			const row = rows[0];
			if (!row) return null;

			return {
				id: row.id,
				accountId: row.accountId,
				channel: row.channel,
				gatewayRef: row.gatewayRef,
				gateway: row.gateway,
				plan: row.plan,
				// `amount_idr` is bigint in the schema; the money rule speaks whole
				// rupiah as a JS number (the same unit PaymentConfirmRecord carries).
				amountIdr: Number(row.amountIdr),
				raw: row.raw ?? undefined
			};
		}
	};
}