// packages/platform/server/mayar-settlement.ts — the Mayar settlement rule.
//
// The webhook is a HINT ONLY (FR-revised H1): it carries at most `event` and
// `data.id`/`data.transactionId`. Every money decision is re-derived
// server-side here:
//
//   1. `getTransaction(hintedId)` re-fetches the ONE authoritative transaction;
//   2. the fetched transaction `id` is bound to what WE persisted at create
//      (`payment.raw.mayar.transactionId`) — never to the webhook's id;
//   3. the fetched transaction must be `status === 'paid'`;
//   4. `Number(tx.amount)` must equal OUR row's `amount_idr`.
//
// Only then are the confirmed facts handed to `confirmAndGrant`
// (payment-confirm.ts), which is the ONE money rule (grant.ts → payments.ts
// resolveGrant → drizzleSubscriptionWriter). No new money rule lives here.
//
// This module is PURE over injected seams (the client's `getTransaction`, the
// payment-row resolver, the payment-confirm store, the subscription writer), so
// the five acceptance cases run in-memory without a database and without the
// network. The webhook route and the reconcile job both call
// `runMayarSettlement` with different resolvers, so they cannot drift.

import { confirmAndGrant } from './payment-confirm.ts';
import type { PaymentConfirmRecord, PaymentConfirmStore } from './payment-confirm.ts';
import type { SubscriptionWriter } from './grant.ts';
import type { MayarTransaction, MayarErrorKind, MayarTransactionPage } from './mayar.ts';

/** The Only federation status that means money moved. Documented by the vendor. */
export const MAYAR_PAID_STATUS = 'paid';
/** The `payment.raw` key we persist at create; settlement matches THIS, not extraData. */
export const MAYAR_RAW_KEY = 'mayar';

/**
 * The facts a settlement consumes from OUR persisted payment row. The webhook
 * supplies only the hinted lookup id; everything else comes from the row.
 */
export interface MayarPaymentFacts {
	/** The store's internal payment id — confirmAndGrant's idempotency anchor. */
	id: string;
	gatewayRef: string;
	gateway: string;
	accountId: string;
	channel: string;
	plan: string;
	amountIdr: number;
	/** The transaction id WE persisted at create (`payment.raw.mayar.transactionId`). */
	transactionId: string | null;
}

/**
 * Read the checkout URL we persisted at create (`payment.raw.mayar.link`). The
 * create path reproduces it on retry so a member always gets the SAME checkout
 * page for their idempotency key.
 */
export function mayarCheckoutUrlOf(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	let obj: unknown = raw;
	if (typeof raw === 'string') {
		try {
			obj = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
	const mayar = (obj as Record<string, unknown>)[MAYAR_RAW_KEY];
	if (typeof mayar !== 'object' || mayar === null || Array.isArray(mayar)) return null;
	const val = (mayar as Record<string, unknown>).link;
	return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

/**
 * Read the transaction id we persisted at create. The webhook body is never
 * trusted to know this — `payment.raw.mayar.transactionId` is OUR write, and
 * the settlement binds the re-fetched transaction to it.
 */
export function mayarTransactionIdOf(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	// `payment.raw` is a jsonb column and may be delivered as a parsed object or
	// a JSON string depending on the caller — accept both without assuming.
	let obj: unknown = raw;
	if (typeof raw === 'string') {
		try {
			obj = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
	const mayar = (obj as Record<string, unknown>)[MAYAR_RAW_KEY];
	if (typeof mayar !== 'object' || mayar === null || Array.isArray(mayar)) return null;
	const val = (mayar as Record<string, unknown>).transactionId;
	return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

/** The verdicts a `GET /transactions/{id}` re-fetch can produce. */
export type SettlementVerdict =
	| { ok: true; transaction: MayarTransaction }
	| { ok: false; reason: MayarErrorKind | 'not_paid' | 'amount_mismatch' | 'raw_id_mismatch' | 'no_transaction_id' };

/**
 * Pure decision: does this re-fetched transaction satisfy the settlement rule
 * for OUR row? `fetched` is the already-fetched transaction and `facts` is OUR
 * row, so the binding (H1) and the amount/status rules stay separable from the
 * network and the DB.
 *
 * `no_transaction_id` is the row whose `payment.raw.mayar.transactionId` is
 * missing — that payment was never bound (create failed mid-persist), so there
 * is nothing to bind a settlement to: refuse, never guess.
 */
export function settlementVerdict(
	fetched: MayarTransaction | null | undefined,
	facts: MayarPaymentFacts
): SettlementVerdict {
	if (!fetched || typeof fetched !== 'object') {
		return { ok: false, reason: 'mayar_unavailable' };
	}
	if (typeof facts.transactionId !== 'string' || facts.transactionId.trim() === '') {
		return { ok: false, reason: 'no_transaction_id' };
	}
	// H1: bind the re-fetched transaction to what WE persisted, never to the
	// webhook's id. A fake id answering an unrelated transaction must never
	// become a grant.
	if (fetched.id !== facts.transactionId) {
		return { ok: false, reason: 'raw_id_mismatch' };
	}
	if (fetched.status !== MAYAR_PAID_STATUS) {
		return { ok: false, reason: 'not_paid' };
	}
	if (!Number.isFinite(fetched.amount) || Number(fetched.amount) !== facts.amountIdr) {
		return { ok: false, reason: 'amount_mismatch' };
	}
	return { ok: true, transaction: fetched };
}

/** The `getTransaction` seam: the adapter's method, or a test fake. */
export type MayarTransactionGetter = (
	id: string
) => Promise<{ ok: true; value: MayarTransaction } | { ok: false; kind: MayarErrorKind; status?: number; message: string }>;

/**
 * Look OUR pending `gateway='mayar'` payment row up by the AUTHORITATIVE
 * transaction id (the one `getTransaction` returned, which must equal
 * `payment.raw.mayar.transactionId`). The webhook's hinted id never selects
 * the row directly.
 */
export type MayarRowResolver = (transactionId: string) => Promise<MayarPaymentFacts | null>;

export interface MayarSettlementDeps {
	getTransaction: MayarTransactionGetter;
	/** Resolve the pending payment row by its persisted transaction id. */
	findPendingByTransactionId: MayarRowResolver;
	store: PaymentConfirmStore;
	writer: SubscriptionWriter;
}

export type MayarSettlementResult =
	| {
			ok: true;
			granted: boolean;
			alreadyConfirmed: boolean;
			paymentId: string;
			subscriptionId: string;
	  }
	| {
			ok: false;
			/** True for every money-refusal: the caller answers ACK 200, no retry. */
			ack: true;
			reason: string;
	  };

/**
 * Re-fetch + bind + confirm. `hintedId` is the webhook's `data.id` — used ONLY
 * to trigger the vendor lookup; the binding is `payment.raw.mayar.transactionId`
 * (H1). Every refusal is `ack: true` so the webhook route ACKs 200 instead of
 * instructing a retry, and the reconcile job logs and moves on.
 *
 * Idempotency: `confirmAndGrant` flips `status` only once (drizzle store
 * compare-and-swap) and the subscription writer's 0038 partial unique is
 * one-payment-id-one-subscription, so a replay or a concurrent reconcile
 * re-delivery mints no second grant.
 */
export async function runMayarSettlement(
	deps: MayarSettlementDeps,
	hintedId: string
): Promise<MayarSettlementResult> {
	const id = typeof hintedId === 'string' ? hintedId.trim() : '';
	if (!id) return { ok: false, ack: true, reason: 'missing_transaction_id' };

	const fetched = await deps.getTransaction(id);
	if (!fetched.ok) {
		// A vendor 404/401/5xx proves nothing about OUR row; ACK without grant.
		return { ok: false, ack: true, reason: fetched.kind };
	}

	// The authoritative transaction id selects OUR row (H1). A webhook that
	// hints a stale/unrelated id either 404s above or resolves to a row whose
	// persisted transaction id differs — passed to the verdict below, which
	// refuses it.
	const facts = await deps.findPendingByTransactionId(fetched.value.id);
	if (!facts) return { ok: false, ack: true, reason: 'unknown_ref' };

	const verdict = settlementVerdict(fetched.value, facts);
	if (!verdict.ok) return { ok: false, ack: true, reason: verdict.reason };

	const record: PaymentConfirmRecord = {
		id: facts.id,
		gatewayRef: facts.gatewayRef,
		gateway: facts.gateway,
		accountId: facts.accountId,
		channel: facts.channel,
		plan: facts.plan,
		amountIdr: facts.amountIdr,
		raw: { [MAYAR_RAW_KEY]: { transactionId: facts.transactionId } }
	};

	const result = await confirmAndGrant({ store: deps.store }, record, deps.writer);
	if (!result.ok) return { ok: false, ack: true, reason: result.reason };

	return {
		ok: true,
		granted: result.grant.created,
		alreadyConfirmed: result.paymentAlreadyConfirmed,
		paymentId: result.paymentId,
		subscriptionId: result.grant.subscriptionId
	};
}

// ------------------------------ reconcile sweep (H4) --------------------------

/** The merchant-transaction listing seam (Mayar's cursor-paginated list). */
export type MayarListTransactions = (input: {
	limit?: number;
	startingAfter?: string | null;
}) => Promise<
	{ ok: true; value: MayarTransactionPage } | { ok: false; kind: MayarErrorKind; status?: number; message: string }
>;

export interface MayarReconcileDeps {
	getTransaction: MayarTransactionGetter;
	listTransactions: MayarListTransactions;
	findPendingByTransactionId: MayarRowResolver;
	store: PaymentConfirmStore;
	writer: SubscriptionWriter;
}

export interface MayarReconcileSummary {
	granted: number;
	candidates: number;
	pages: number;
	stopped: boolean;
}

/**
 * The H4 sweep: cursor-paginate the merchant's settled transactions and, for
 * each `paid`/`settled` item whose authoritative transaction id maps to a still
 * `pending` `gateway='mayar'` row, run the SAME settlement flow as the webhook.
 *
 * Idempotent by construction: a row already granted no longer matches the
 * `pending` resolver, so a second run mints nothing. The loop is bounded by
 * `maxPages` so one run cannot hold the fleet behind an unbounded history; the
 * next scheduled run resumes from the cursor it did not reach (the `hasMore`
 * cursor is intentionally not persisted — a re-scan is safe because every grant
 * is idempotent).
 */
export async function reconcileMayarPayments(
	deps: MayarReconcileDeps,
	opts: { maxPages?: number; limit?: number } = {}
): Promise<MayarReconcileSummary> {
	const maxPages = Math.max(1, Math.floor(Number(opts.maxPages ?? 20)));
	const limit = Math.min(50, Math.max(1, Math.floor(Number(opts.limit ?? 50))));
	let granted = 0;
	let candidates = 0;
	let pages = 0;
	let startingAfter: string | null = null;
	let stopped = false;

	for (let page = 0; page < maxPages; page++) {
		const pageRes = await deps.listTransactions({ limit, startingAfter });
		if (!pageRes.ok) {
			stopped = false; // a vendor failure is not "done"; next run retries.
			break;
		}
		pages += 1;
		for (const item of pageRes.value.items) {
			const txId = typeof item.transactionId === 'string' ? item.transactionId : item.id;
			if (!txId) continue;
			if (item.status !== 'paid' && item.status !== 'settled') continue;
			candidates += 1;
			const result = await runMayarSettlement(
				{
					getTransaction: deps.getTransaction,
					findPendingByTransactionId: deps.findPendingByTransactionId,
					store: deps.store,
					writer: deps.writer
				},
				txId
			);
			if (result.ok && result.granted) granted += 1;
		}
		if (!pageRes.value.hasMore || !pageRes.value.nextStartingAfter) break;
		startingAfter = pageRes.value.nextStartingAfter;
		if (page === maxPages - 1) stopped = true;
	}

	return { granted, candidates, pages, stopped };
}
