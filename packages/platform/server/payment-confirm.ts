// packages/platform/server/payment-confirm.ts — the confirm→grant loop (B3b).
//
// This module is the step that CLOSES the money loop: a VERIFIED-and-settled
// settlement (B3a's inbound webhook receiver) becomes
//
//   1. a confirmed payment row   — the durable evidence of "money moved", via
//      the injected store's idempotent UPDATE to status 'confirmed';
//   2. a subscription window     — the time the member bought, via
//      grantForPayment (B2), always under the flat-fee bucket `frsubs`;
//   3. NOTHING ELSE             — in particular, NO `credit_purchase` ledger
//      posting.
//
// Why no credit_purchase for these plans (the S3 bug): every priced plan today
// (payments.ts PLANS) sells TIME, not tokens — a flat 1d/3d/7d/14d/28d window.
// The ledger's `credit_purchase` credits a metered PREPAID balance
// (billing_account.balance_micro), and a subscription buyer has no metered
// balance to credit: their entitlement is the subscription row's
// `economic_bucket = 'frsubs'`, which the Go admission gate reads directly
// (FR-revised §7 invariant 2/3; "beli 7d → resolve ke BucketSubs, bukan
// frpayg"). Posting credit_purchase here would mint a phantom spendable balance
// on top of a flat window — double money — so this module deliberately does not.
// (D-economics' frpayg prepaid plans, which WOULD post credit_purchase, are
// dormant per FR-revised §1 until the revenue signal.)
//
// The rule that decides WHAT may grant stays in payments.ts resolveGrant,
// reached through grantForPayment (B2) — this module does NOT re-encode the
// plan table, the amount check or the status gate. It calls grantForPayment
// with a SYNTHETIC 'confirmed' status (the settlement already proved payment)
// and the VERIFIED gateway amount, so an amount mismatch / unknown plan is
// refused here with resolveGrant's own reason, verbatim.
//
// Core ≠ transport: `confirmAndGrant` is pure over injected seams. The store
// (payment confirm) and the writer (grant) are injected so the four-case test
// runs in-memory; the Express route (apps/web/server/payment-confirm.mjs)
// supplies drizzlePaymentConfirmStore + drizzleSubscriptionWriter.

import { sql } from 'drizzle-orm';

import {
	grantForPayment,
	type GrantForPaymentOk,
	type GrantRejectReason,
	type SubscriptionWriter
} from './grant.ts';
import { payment } from './db/schema.ts';
import type { DbTx } from './audit.ts';

/** The facts a verified settlement carries, plus the store's internal payment id. */
export interface PaymentConfirmRecord {
	/** The store's internal payment id (`payment.id`) — B2's idempotency anchor. */
	id: string | null;
	gatewayRef: string;
	gateway: string;
	accountId: string;
	channel: string;
	plan: string;
	/** The VERIFIED gateway amount in whole rupiah (compare against the plan price). */
	amountIdr: number;
	/** Raw settlement body, kept for the dispute trail only (migration 0025 `raw`). */
	raw?: unknown;
}

export interface PaymentConfirmStore {
	/**
	 * Persist the payment's transition to 'confirmed'. Idempotent: durable
	 * `returning` on the status flip so a replayed settlement updates the SAME
	 * row and reports `alreadyConfirmed`, never a second payment.
	 */
	confirmPayment(record: PaymentConfirmRecord): Promise<{ id: string; alreadyConfirmed: boolean }>;
}

export interface ConfirmAndGrantContext {
	store: PaymentConfirmStore;
	/** Frozen clock for tests; defaults to wall clock. */
	now?: Date;
}

export interface GrantInput {
	accountId: string;
	paymentId: string;
	gatewayRef: string;
	plan: string;
	days: number;
	priceIdr: number;
	expiresAt: Date;
	bucket: string;
}

/** The reasons a confirm may refuse: transport-level unknowns + the money rule. */
export type ConfirmRejectReason = 'no_payment_id' | 'unknown_ref' | GrantRejectReason;

export type ConfirmAndGrantResult =
	| {
			ok: true;
			paymentId: string;
			paymentConfirmed: boolean;
			paymentAlreadyConfirmed: boolean;
			grant: GrantForPaymentOk;
			grantInput: GrantInput;
	  }
	| { ok: false; reason: ConfirmRejectReason };

/**
 * Turn a VERIFIED settlement into one confirmed payment + one frsubs window.
 *
 * Order is deliberate:
 *
 *   1. a record with no internal id is 'no_payment_id'  — there is nothing to
 *      anchor the grant to, so the caller must answer "unknown";
 *   2. the grant rule runs FIRST, before any write  — an amount mismatch or
 *      unknown plan must never confirm a payment row (a rejected claim is not
 *      money and must not look paid);
 *   3. the payment is confirmed  — idempotent UPDATE on the durable store;
 *   4. the window is granted  — one payment_id, one subscription (0038).
 *
 * The amount-vs-plan check and plan existence are NOT re-encoded: they are
 * grantForPayment → resolveGrant's single source of truth.
 */
export async function confirmAndGrant(
	ctx: ConfirmAndGrantContext,
	record: PaymentConfirmRecord | null | undefined,
	writer: SubscriptionWriter
): Promise<ConfirmAndGrantResult> {
	if (!record || typeof record !== 'object') {
		return { ok: false, reason: 'unknown_ref' };
	}
	if (typeof record.id !== 'string' || record.id.trim() === '') {
		return { ok: false, reason: 'no_payment_id' };
	}
	if (typeof record.gatewayRef !== 'string' || record.gatewayRef.trim() === '') {
		return { ok: false, reason: 'unknown_ref' };
	}

	// The rule FIRST — a wrong amount/plan must not confirm a payment.
	const grant = await grantForPayment(
		writer,
		{
			accountId: record.accountId,
			paymentId: record.id,
			plan: record.plan,
			amountIdr: record.amountIdr
		},
		ctx.now ?? new Date()
	);
	if (!grant.ok) {
		return { ok: false, reason: grant.reason };
	}

	// Only now, after the rule passed, do we persist the confirmation.
	const confirmed = await ctx.store.confirmPayment(record);

	const grantInput: GrantInput = {
		accountId: record.accountId,
		paymentId: record.id,
		gatewayRef: record.gatewayRef,
		plan: grant.plan,
		days: grant.days,
		priceIdr: grant.priceIdr,
		expiresAt: grant.expiresAt,
		bucket: grant.bucket
	};

	return {
		ok: true,
		paymentId: record.id,
		paymentConfirmed: true,
		paymentAlreadyConfirmed: confirmed.alreadyConfirmed,
		grant,
		grantInput
	};
}

/**
 * The drizzle-backed payment-confirm store.
 *
 * Idempotent: an UPDATE with a compare-and-swap on `status` so a replayed
 * settlement updates the SAME row once and reports `alreadyConfirmed` — never a
 * second payment, never a second grant. Only a non-confirmed row flips; an
 * already-confirmed row returns it unchanged. `raw` is stored only for the
 * dispute trail (migration 0025), never parsed here.
 */
export function drizzlePaymentConfirmStore(db: DbTx): PaymentConfirmStore {
	return {
		async confirmPayment(record: PaymentConfirmRecord): Promise<{ id: string; alreadyConfirmed: boolean }> {
			const set: Record<string, unknown> = {
				status: 'confirmed',
				updatedAt: new Date()
			};
			if (record.raw !== undefined) {
				set.raw = record.raw as Record<string, unknown>;
			}
			const rows = await db
				.update(payment)
				.set(set)
				.where(sql`${payment.id} = ${record.id} and ${payment.status} <> 'confirmed'`)
				.returning({ id: payment.id });

			if (rows.length > 0) {
				return { id: rows[0].id, alreadyConfirmed: false };
			}

			// Already confirmed (replay): the id is the same payment, not a new
			// one. No throw — a replayed settlement is a normal, idempotent case.
			return { id: record.id as string, alreadyConfirmed: true };
		}
	};
}