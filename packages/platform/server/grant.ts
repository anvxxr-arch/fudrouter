// packages/platform/server/grant.ts — the subscription grant writer (B2).
//
// This module owns the WRITE half of a settled payment: it turns the facts a
// gateway confirm produced (account, payment id, plan, amount) into one
// subscription row that sells the window under the flat-fee bucket `frsubs`.
//
// The DECISION half stays in payments.ts `resolveGrant` — the single source of
// truth for what may or may not grant. `grantForPayment` calls it and ONLY it:
// no copy of the plan table, the amount check or the status gate lives here, so
// a future change to `resolveGrant` reaches the writer for free. The bucket a
// plan implies is derived, not looked up per call, and is a constant because
// every priced plan today is a flat-fee subscription window (all five prices
// are whole-rupiah, time-based; the design §3.1 precedent `frsubs`).
//
// Idempotency is the writer's other half: one `payment_id` is one subscription,
// enforced by the partial UNIQUE index 0038 (`subscription_payment_id_uniq` on
// `payment_id IS NOT NULL`) and surfaced here by the injected writer. A replayed
// confirm must return `created: false` with the SAME subscription id — never a
// second window, never a second key.
//
// The writer is injected (SubscriptionWriter) so the four-case test runs against
// an in-memory stand-in with the same idempotency rule, while the real webhook
// receiver supplies the drizzle-backed `drizzleSubscriptionWriter`. This is the
// same split gateway.ts thread: decisions here, storage injected there.

import { sql } from 'drizzle-orm';

import { resolveGrant, type GrantResult } from './payments.ts';
import { ID_PREFIXES, newId } from './id.ts';
import type { DbTx } from './audit.ts';

/** The economic class every priced plan sells under today (design §3.1 K2). */
export const SUBSCRIPTION_BUCKET = 'frsubs';

/** The payment facts the writer needs. `paymentId` is B2's idempotency anchor. */
export interface GrantPayment {
	accountId: string;
	/** The internal payment id (PaymentRecord.id), NOT the gateway ref. */
	paymentId: string;
	plan: string;
	amountIdr: number;
}

/** One window to persist. `bucket` is the tier a live window resolves to. */
export interface NewSubscription {
	accountId: string;
	paymentId: string;
	plan: string;
	days: number;
	priceIdr: number;
	expiresAt: Date;
	bucket: string;
}

/**
 * The persist seam. The durable contract is idempotency on `paymentId`: a
 * retry must return `{ id: <existing>, created: false }`, matching the 0038
 * unique index (the same ON CONFLICT discipline the Go writer applies and the
 * ledger already relies on for `usage:<request id>`).
 */
export interface SubscriptionWriter {
	grant(args: NewSubscription): Promise<{ id: string; created: boolean }>;
}

/**
 * The refusal reason, verbatim from `resolveGrant` (payments.ts). It is
 * DERIVED from `GrantResult`, never hand-copied: if `resolveGrant` ever adds a
 * refusal reason, this type and every caller follow it for free.
 */
export type GrantRejectReason = Extract<GrantResult, { ok: false }>['reason'];

/** The successful-write half of the grant result. */
export interface GrantForPaymentOk {
	ok: true;
	subscriptionId: string;
	/** False on a payment replay: the window already exists from a prior grant. */
	created: boolean;
	plan: string;
	days: number;
	priceIdr: number;
	expiresAt: Date;
	bucket: string;
}

export type GrantForPaymentResult = GrantForPaymentOk | { ok: false; reason: GrantRejectReason };

/**
 * Turn a settled payment into one persisted subscription window.
 *
 * The rule that a payment may grant is `resolveGrant`'s and only its own: an
 * unknown plan, a short amount, or a non-confirmed status is refused here with
 * `resolveGrant`'s reason verbatim — never guessed and never re-encoded (the
 * callers and the four-case test pin that the reason is the shared rule's, not
 * a local copy).
 */
export async function grantForPayment(
	writer: SubscriptionWriter,
	payment: GrantPayment,
	now: Date = new Date()
): Promise<GrantForPaymentResult> {
	const grant = resolveGrant(
		{ plan: payment.plan, status: 'confirmed', amountIdr: payment.amountIdr },
		now
	);
	if (!grant.ok) {
		return { ok: false, reason: grant.reason };
	}

	const { id, created } = await writer.grant({
		accountId: payment.accountId,
		paymentId: payment.paymentId,
		plan: grant.plan,
		days: grant.days,
		priceIdr: grant.priceIdr,
		expiresAt: grant.expiresAt,
		bucket: SUBSCRIPTION_BUCKET
	});

	return {
		ok: true,
		subscriptionId: id,
		created,
		plan: grant.plan,
		days: grant.days,
		priceIdr: grant.priceIdr,
		expiresAt: grant.expiresAt,
		bucket: SUBSCRIPTION_BUCKET
	};
}

/**
 * The drizzle-backed persist seam the webhook receiver (B3a/B3b) supplies.
 *
 * Idempotency mirrors the Go writer exactly: an INSERT with
 * `ON CONFLICT DO NOTHING` on the 0038 partial unique index, then a re-select
 * of the winner on conflict so the second delivery returns the FIRST row instead
 * of minting a duplicate. The amount is stored as whole rupiah — the same unit
 * `resolveGrant` speaks and `payment.amount_idr` already stores.
 */
export function drizzleSubscriptionWriter(db: DbTx): SubscriptionWriter {
	return {
		async grant(args: NewSubscription): Promise<{ id: string; created: boolean }> {
			const id = newId(ID_PREFIXES.subscription);
			const inserted = (
				await db.execute(
					sql`
						insert into subscription
							(id, account_id, plan, status, starts_at, expires_at, price_idr, payment_id, economic_bucket)
						values
							(${id}, ${args.accountId}, ${args.plan}, 'active', now(), ${args.expiresAt}, ${args.priceIdr}, ${args.paymentId}, ${args.bucket})
						on conflict (payment_id) where payment_id is not null do nothing
						returning id`
				)
			) as unknown as { id: string }[];

			if (inserted.length > 0) {
				return { id: inserted[0].id, created: true };
			}

			// Lost the insert race: another grant for this payment_id already
			// landed. Return the winner's row — the second delivery is one
			// window, not two.
			const existing = (
				await db.execute(
					sql`select id from subscription where payment_id = ${args.paymentId} limit 1`
				)
			) as unknown as { id: string }[];
			return { id: existing[0]?.id ?? id, created: false };
		}
	};
}