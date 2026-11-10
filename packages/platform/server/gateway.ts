// packages/platform/server/gateway.ts — the payment gateway interface.
//
// This module owns the INTERFACE a payment gateway must satisfy: how a payment
// is created, how a gateway's settlement callback is verified, and how a
// settled payment turns into a subscription grant. It is written BEFORE any
// vendor is chosen (ADR-0008) so the contract — idempotent create, HMAC-verified
// callback with anti-replay, and a single grant rule — is a decision the
// vendor adapters implement, never one they get to improvise.
//
// Money note: every `amountIdr` in this module is WHOLE rupiah as an integer,
// the unit `payments.ts` prices plans in (sub_7d = 30000). The subscription
// side stores whole rupiah too (`price_idr`, migration 0025) — the unit is the
// SAME across the payment interface, the grant writer (B2, ./grant.ts) and the
// reader (apps/web/server/pages.mjs), matching `resolveGrant`, so no conversion
// can creep in between verification and grant. (The ledger's micro-unit
// convention is a separate, ledger-only concern, not subscription money.)
//
// Core ≠ transport: these functions are the decisions. Persistent storage,
// secret lookup and the SSRF-guarded outbound fetch are INJECTED through the
// `ctx` arguments, so a test can supply an in-memory store, an in-memory
// subscription writer and a frozen clock while the real webhook receiver (B3a)
// supplies Postgres, the operator-held secret, the drizzle-backed writer and
// `assertPublicUpstream` from ./ssrf.ts.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { isChannel, planOf, qrisFor } from './payments.ts';

// ------------------------------ vocabulary ---------------------------------

/**
 * The gateway-reference namespace this interface mints (FR-revised §S5).
 * `purchase:<ref>` is reserved for the payment gateway: the manual top-up
 * writers moved off it in migration 0036 so a retry of the gateway's own ref
 * can never collide with — and silently drop — a legacy admin posting.
 */
export const GATEWAY_PURCHASE_PREFIX = 'purchase:';

/** The gateway identity until a vendor is selected (ADR-0008). */
export const GATEWAY_DEFAULT = 'qris-native';

/** The inbound callback signature header, `sha256=<hex HMAC of raw body>`. */
export const GATEWAY_SIGNATURE_HEADER = 'x-gateway-signature';

/** How old a callback may be before it is refused as a replay/stale. */
export const GATEWAY_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** The settlement code the default vendor vocabulary treats as "paid". */
export const GATEWAY_SETTLED_CODE = 'OK';

export type PaymentStatus =
	| 'pending'
	| 'claimed'
	| 'confirmed'
	| 'rejected'
	| 'failed'
	| 'expired'
	| 'refunded';

/** A payment row as the store returns it. `id` is minted by the store/transport. */
export interface NewPayment {
	/** Our idempotent link: `purchase:<idempotencyKey>` (see gatewayRefFor). */
	gatewayRef: string;
	/** Which gateway the payment was created through (`qris-native` by default). */
	gateway: string;
	accountId: string;
	channel: string;
	plan: string;
	amountIdr: number;
	status: PaymentStatus;
}

/** A persisted payment: `id` is the store's internal payment id. */
export interface PaymentRecord extends NewPayment {
	id: string;
	/** Raw vendor envelope (migration 0025 `raw`). Mayar stores its create facts here. */
	raw?: unknown;
}

// --------------------------- createPayment ---------------------------------

export interface GatewayStore {
	/** Find a payment by our gatewayRef, or null when none exists yet. */
	findPayment(gatewayRef: string): Promise<PaymentRecord | null>;
	/**
	 * Persist a new payment and return it with its internal `id` assigned.
	 *
	 * This MUST be idempotent on the durable UNIQUE (gateway, gateway_ref) index
	 * (migration 0025), not just the find-then-insert pair above: two concurrent
	 * `createPayment` calls for the same ref both see `null` from `findPayment`,
	 * and the loser of the insert race must return the winner's row (an
	 * `onConflictDoNothing(...).returning()` or `select then insert
	 * on-conflict-do-nothing then re-select`), never throw and never overwrite.
	 * The same pattern the ledger already uses in billing.ts `postLedger`.
	 */
	insertPayment(payment: NewPayment): Promise<PaymentRecord>;
}

export interface CreatePaymentInput {
	accountId: string;
	channel: string;
	plan: string;
	amountIdr: number;
	/** Caller-supplied retry token; namespaced into `purchase:<key>`. */
	idempotencyKey: string;
}

export interface CreatePaymentContext {
	store: GatewayStore;
}

export type CreateRejectReason =
	| 'missing_idempotency_key'
	| 'invalid_amount'
	| 'unknown_plan'
	| 'invalid_channel'
	| 'bad_payload';

export type CreatePaymentResult =
	| { ok: true; gatewayRef: string; qr: string; record: PaymentRecord; state: 'created' | 'existing' }
	| { ok: false; reason: CreateRejectReason };

/**
 * Derive the gateway reference we own for a retry token. Deterministic: the
 * same `idempotencyKey` always yields the same ref, and the store's UNIQUE
 * (gateway, gateway_ref) index (migration 0025) makes the insert idempotent —
 * a retried `createPayment` returns the existing row, never a second payment.
 */
export function gatewayRefFor(idempotencyKey: string): string {
	return `${GATEWAY_PURCHASE_PREFIX}${idempotencyKey}`;
}

/**
 * Create a payment attempt. Idempotent on OUR gateway ref: a retry with the
 * same `idempotencyKey` reproduces the same `gatewayRef`, `qr` and record, and
 * reports `state: 'existing'` instead of minting a duplicate.
 *
 * The QRIS payload is built by `qrisFor` (payments.ts) — the single source for
 * amount injection — never re-encoded here.
 */
export async function createPayment(
	ctx: CreatePaymentContext,
	input: CreatePaymentInput
): Promise<CreatePaymentResult> {
	const key = String(input.idempotencyKey ?? '').trim();
	if (!key) return { ok: false, reason: 'missing_idempotency_key' };

	if (!planOf(input.plan)) return { ok: false, reason: 'unknown_plan' };
	if (!isChannel(input.channel)) return { ok: false, reason: 'invalid_channel' };

	const amount = Number(input.amountIdr);
	// Money is an integer: a fractional rupiah is a caller bug, not a price.
	if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
		return { ok: false, reason: 'invalid_amount' };
	}

	const qr = qrisFor(amount);
	// qrisFor returns null for non-positive amounts (already guarded above), so
	// a null here means the pinned merchant payload (payments.ts) is malformed —
	// a distinct, loud failure rather than a silent bad QR.
	if (qr === null) return { ok: false, reason: 'bad_payload' };

	const gatewayRef = gatewayRefFor(key);
	const existing = await ctx.store.findPayment(gatewayRef);
	if (existing) {
		// An idempotencyKey owns ONE payment intent. A retry that changes the
		// amount must NOT hand back a QR for the retry's amount while the record
		// keeps the first intent's amount — the member would pay X and the
		// settlement would verify against Y. Reproduce the FIRST intent in full:
		// the same record, and the QR for the record's own amount.
		return {
			ok: true,
			gatewayRef,
			qr: qrisFor(existing.amountIdr) ?? qr,
			record: existing,
			state: 'existing'
		};
	}

	const record = await ctx.store.insertPayment({
		gatewayRef,
		gateway: GATEWAY_DEFAULT,
		accountId: input.accountId,
		channel: input.channel,
		plan: input.plan,
		amountIdr: amount,
		status: 'pending'
	});
	// `insertPayment` is onConflict-idempotent, so under a lost race `record` is
	// the winner's row; a duplicate only ever surfaces as `state: 'existing'` on
	// a RETRY, never as a second row.
	return { ok: true, gatewayRef, qr, record, state: 'created' };
}

// --------------------------- verifyCallback --------------------------------

/**
 * The default vendor's callback vocabulary (ADR-0008): `code === 'OK'` means
 * settled, `amount` is whole rupiah, `ref` is the gatewayRef we minted at
 * create. Concrete vendor adapters translate their own envelope into this shape
 * before it reaches `verifyCallback`.
 */
export interface GatewayCallback {
	code: string;
	amount: number;
	ref: string;
	nonce: string;
	/** Unix epoch milliseconds, used for the replay window. */
	timestamp: number;
	/** Optional vendor transaction id, kept for the dispute trail only. */
	paymentRef?: string;
	/**
	 * Optional URL the gateway asks us to call back to double-check settlement.
	 * When present, it MUST pass the SSRF outbound guard before any fetch.
	 */
	verifyUrl?: string;
}

export type CallbackParseRejectReason =
	| 'bad_body'
	| 'missing_ref'
	| 'missing_nonce'
	| 'bad_timestamp'
	| 'missing_amount';

export type CallbackParseResult =
	| { ok: true; callback: GatewayCallback }
	| { ok: false; reason: CallbackParseRejectReason };

/**
 * Parse a raw callback body into the default vendor shape. Pure — no secret, no
 * clock, no store — so the parser and the verifier are separable.
 *
 * `missing_ref` is the "unknown" case: without a gatewayRef there is no payment
 * to link this callback to, and the caller must answer "unknown", never guess.
 */
export function parseCallback(rawBody: string): CallbackParseResult {
	if (typeof rawBody !== 'string' || rawBody.trim() === '') {
		return { ok: false, reason: 'bad_body' };
	}
	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return { ok: false, reason: 'bad_body' };
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, reason: 'bad_body' };
	}
	const b = body as Record<string, unknown>;

	const code = typeof b.code === 'string' ? b.code : '';
	const ref = typeof b.ref === 'string' ? b.ref.trim() : '';
	const nonce = typeof b.nonce === 'string' ? b.nonce.trim() : '';
	const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? b.amount : NaN;
	const timestamp = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? b.timestamp : NaN;
	const paymentRef = typeof b.payment_ref === 'string' && b.payment_ref.trim() !== '' ? b.payment_ref.trim() : undefined;
	const verifyUrl = typeof b.verify_url === 'string' && b.verify_url.trim() !== '' ? b.verify_url.trim() : undefined;

	// ref and nonce are load-bearing (idempotency + anti-replay): absence is a
	// distinct reason, not a default.
	if (!ref) return { ok: false, reason: 'missing_ref' };
	if (!nonce) return { ok: false, reason: 'missing_nonce' };
	if (!Number.isFinite(timestamp)) return { ok: false, reason: 'bad_timestamp' };
	// Money is an integer; a negative/fractional amount must not even reach the
	// grant rule.
	if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
		return { ok: false, reason: 'missing_amount' };
	}

	const callback: GatewayCallback = { code, amount, ref, nonce, timestamp };
	if (paymentRef !== undefined) callback.paymentRef = paymentRef;
	if (verifyUrl !== undefined) callback.verifyUrl = verifyUrl;
	return { ok: true, callback };
}

/**
 * Sign a callback body with the shared gateway secret. Exported so a test can
 * forge a valid callback and so a future vendor adapter can verify the same
 * convention from the sender's side; the receiver path uses
 * `verifyCallbackSignature`.
 */
export function signCallback(rawBody: string, secret: string): string {
	return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Constant-time verify of the inbound callback signature. The header must be
 * the exact `sha256=<hex>` of the raw body — the same single serialization both
 * hashed and compared (the classic webhook bug is signing one string and
 * checking another).
 */
export function verifyCallbackSignature(
	rawBody: string,
	headerValue: string | undefined,
	secret: string
): boolean {
	if (typeof headerValue !== 'string' || headerValue.trim() === '') return false;
	const expected = signCallback(rawBody, secret);
	const a = Buffer.from(headerValue.trim());
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a callback timestamp is within the replay window of `nowMs`. */
export function nonceFresh(timestampMs: number, nowMs: number, windowMs: number): boolean {
	if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || !Number.isFinite(windowMs)) {
		return false;
	}
	return Math.abs(nowMs - timestampMs) <= windowMs;
}

export interface CallbackNonceStore {
	/**
	 * Atomically claim a callback nonce. Returns `true` on the FIRST sighting —
	 * the call may proceed — and `false` when the nonce was already seen, which
	 * is the replay the gateway must never turn into a second grant.
	 */
	claim(nonce: string): Promise<boolean>;
}

export interface VerifyContext {
	/** The shared gateway secret the HMAC was keyed with. */
	secret: string;
	nonces: CallbackNonceStore;
	/** Frozen clock for tests; defaults to wall clock. */
	now?: Date;
	replayWindowMs?: number;
	/**
	 * The SSRF outbound guard, wired to `assertPublicUpstream` (./ssrf.ts) by the
	 * transport. Invoked only when the callback carries `verifyUrl` (a gateway
	 * that needs a validation call-back). No outbound fetch happens here — the
	 * guard's verdict is the decision, the transport owns the dial.
	 */
	assertOutbound?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type VerifyRejectReason =
	| CallbackParseRejectReason
	| 'bad_signature'
	| 'stale_timestamp'
	| 'replay'
	| 'not_settled'
	| 'outbound_blocked'
	| 'outbound_unwired';

export type VerifyCallbackResult =
	| { ok: true; gatewayRef: string; amountIdr: number; paymentRef: string | null }
	| { ok: false; reason: VerifyRejectReason };

/**
 * Verify a gateway settlement callback and return the payment facts, or a typed
 * refusal. Order is deliberate:
 *
 *   1. parse                    — shape errors, incl. the unknown `missing_ref`;
 *   2. HMAC verify (constant time) — an unsigned/forged body stops here and
 *      NEVER burns a nonce (a bad-signature flood cannot exhaust the replay
 *      table);
 *   3. anti-replay window       — a body outside the window is stale;
 *   4. nonce claim              — a replayed nonce is the "no double grant"
 *      gate: the second delivery of an already-processed callback is refused;
 *   5. SSRF outbound guard      — only when the callback requires validation
 *      back (native QRIS manual confirm does not);
 *   6. settlement code          — `OK` means paid; anything else is not money.
 */
export async function verifyCallback(
	ctx: VerifyContext,
	rawBody: string,
	headers: Record<string, string | undefined>
): Promise<VerifyCallbackResult> {
	const parsed = parseCallback(rawBody);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	const cb = parsed.callback;

	const headerValue = headers[GATEWAY_SIGNATURE_HEADER];
	if (!verifyCallbackSignature(rawBody, headerValue, ctx.secret)) {
		return { ok: false, reason: 'bad_signature' };
	}

	const nowMs = (ctx.now ?? new Date()).getTime();
	const windowMs = ctx.replayWindowMs ?? GATEWAY_REPLAY_WINDOW_MS;
	if (!nonceFresh(cb.timestamp, nowMs, windowMs)) {
		return { ok: false, reason: 'stale_timestamp' };
	}

	const first = await ctx.nonces.claim(cb.nonce);
	if (!first) return { ok: false, reason: 'replay' };

	if (cb.verifyUrl !== undefined) {
		if (!ctx.assertOutbound) return { ok: false, reason: 'outbound_unwired' };
		const guard = await ctx.assertOutbound(cb.verifyUrl);
		if (!guard.ok) return { ok: false, reason: 'outbound_blocked' };
	}

	if (cb.code !== GATEWAY_SETTLED_CODE) {
		return { ok: false, reason: 'not_settled' };
	}

	return {
		ok: true,
		gatewayRef: cb.ref,
		amountIdr: cb.amount,
		paymentRef: cb.paymentRef ?? null
	};
}

