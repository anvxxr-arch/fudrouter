// packages/platform/server/webhook-receiver.ts — the inbound gateway callback
// receiver (B3a).
//
// This module is the TRANSPORT half of the inbound settlement callback: it
// verifies the HMAC and freshness of a gateway callback that arrived over HTTP,
// claims the delivery's nonce (anti-replay), and guards the optional
// validate-back URL (SSRF). It is deliberately NOT the outbound `deliverWebhook`
// path — webhooks.ts signs and sends OUR events; this file receives and verifies
// the GATEWAY's settlement callback, keyed with the same `x-fud-signature`
// convention but decrypted from the S0 envelope (credentials.ts).
//
// Pure + injected seams: the secret envelope, the nonce store, the delivery
// idempotency anchor and the outbound SSRF guard are all injected through `ctx`
// so the four-case test runs in-memory, matching gateway.ts's "decisions here,
// storage injected there" split (FR-revised §7.1, ADR-0008).
//
// Signature: `X-FUD-Signature: sha256=<hex HMAC of the exact raw body>` keyed
// with the shared gateway secret carried in an S0 AES-GCM envelope. The header
// name MUST stay equal to webhooks.ts `SIGNATURE_HEADER` — a receiver that
// looked up a different header would silently accept a body the sender never
// signed. `signBody` there signs the same SHA-256 HMAC; the KEY DERIVATION
// below (secret → api_key → JSON.stringify) is repeated on purpose because
// importing webhooks.ts would pull db/index.ts (which throws without
// DATABASE_URL), and this module must stay importable in a pure test.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { decryptCredentials } from './credentials.ts';
import {
	parseCallback,
	nonceFresh,
	GATEWAY_SETTLED_CODE,
	GATEWAY_REPLAY_WINDOW_MS
} from './gateway.ts';

/** The inbound callback signature header (equal to webhooks.ts `SIGNATURE_HEADER`). */
export const INBOUND_SIGNATURE_HEADER = 'x-fud-signature';

/**
 * Derive the HMAC signing key from the S0 envelope the same way webhooks.ts
 * `signBody` does: `secret` when present, else `api_key`, else the raw JSON of
 * the decrypted envelope (so a plain-string secret envelope also works). Never
 * logs or returns the secret except as the key handed straight to the HMAC.
 */
export function inboundSigningKey(secretEnc: string | null): string | null {
	if (!secretEnc) return null;
	const plain = decryptCredentials(secretEnc);
	if (typeof plain.secret === 'string') return plain.secret;
	if (typeof plain.api_key === 'string') return plain.api_key;
	return JSON.stringify(plain);
}

/**
 * Sign an inbound callback body (the receiver-side mirror of webhooks.ts
 * `signBody`, without the db-pulling import). Exported so a test can forge a
 * valid callback and so the route's verification is separable.
 */
export function signInbound(rawBody: string, secretEnc: string | null): string | null {
	const key = inboundSigningKey(secretEnc);
	if (key === null) return null;
	return `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`;
}

/**
 * Constant-time verify of the inbound callback signature. The header must be
 * the exact `sha256=<hex>` of the raw body — the same single serialization both
 * hashed and compared (the classic webhook bug is signing one string and
 * checking another). A missing envelope or header fails closed, and a bad
 * signature never burns a nonce (a signature flood cannot exhaust the replay
 * table — ADR-0008 criterion #4).
 */
export function verifyInboundSignature(
	rawBody: string,
	headerValue: string | undefined,
	secretEnc: string | null
): boolean {
	const expected = signInbound(rawBody, secretEnc);
	if (expected === null) return false;
	if (typeof headerValue !== 'string' || headerValue.trim() === '') return false;
	const a = Buffer.from(headerValue.trim());
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export type InboundRejectReason =
	| 'bad_body'
	| 'missing_ref'
	| 'missing_nonce'
	| 'bad_timestamp'
	| 'missing_amount'
	| 'bad_signature'
	| 'stale_timestamp'
	| 'not_settled';

export interface InboundVerifyContext {
	/** The S0 AES-GCM envelope holding the shared gateway HMAC secret. */
	secretEnc: string | null;
	/** Frozen clock for tests; defaults to wall clock. */
	now?: Date;
	/** Anti-replay window; defaults to the gateway constant. */
	replayWindowMs?: number;
}

export type InboundVerifyResult =
	| {
			ok: true;
			gatewayRef: string;
			nonce: string;
			amountIdr: number;
			paymentRef: string | null;
			/** Present only when the gateway asks for a validation call-back. */
			verifyUrl: string | null;
	  }
	| { ok: false; reason: InboundRejectReason };

/**
 * Verify a gateway callback's body shape, signature, freshness and settlement
 * code, in that order. Deliberately narrow — the nonce CLAIM is `claimDelivery`
 * (below), and the SSRF outbound guard is `assertInboundPublic`, both separate
 * so the route can order them correctly (verify → guard → claim → confirm):
 *
 *   1. parse          — shape errors, incl. the unknown `missing_ref`;
 *   2. HMAC verify    — constant time, an unsigned/forged body stops before any
 *                       nonce work;
 *   3. replay window  — a body outside the window is stale;
 *   4. settlement code — `OK` means paid; anything else is not money.
 */
export async function verifyInbound(
	ctx: InboundVerifyContext,
	rawBody: string,
	headers: Record<string, string | undefined>
): Promise<InboundVerifyResult> {
	const parsed = parseCallback(rawBody);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	const cb = parsed.callback;

	if (!verifyInboundSignature(rawBody, headers[INBOUND_SIGNATURE_HEADER], ctx.secretEnc)) {
		return { ok: false, reason: 'bad_signature' };
	}

	const nowMs = (ctx.now ?? new Date()).getTime();
	const windowMs = ctx.replayWindowMs ?? GATEWAY_REPLAY_WINDOW_MS;
	if (!nonceFresh(cb.timestamp, nowMs, windowMs)) {
		return { ok: false, reason: 'stale_timestamp' };
	}

	if (cb.code !== GATEWAY_SETTLED_CODE) {
		return { ok: false, reason: 'not_settled' };
	}

	return {
		ok: true,
		gatewayRef: cb.ref,
		nonce: cb.nonce,
		amountIdr: cb.amount,
		paymentRef: cb.paymentRef ?? null,
		verifyUrl: cb.verifyUrl ?? null
	};
}

// ------------------------------ claimDelivery --------------------------------

export interface NonceStore {
	/**
	 * Atomically claim a nonce for the replay window. `true` on the FIRST
	 * sighting (proceed); `false` when already seen, which is the replay that
	 * must never turn into a second grant. `ttlMs` bounds the table: once the
	 * window has elapsed the nonce is no longer a replay, and the DURABLE
	 * idempotency anchor is `payment.gateway_ref` (0025), not this cache.
	 */
	claim(nonce: string, ttlMs: number): Promise<boolean>;
}

export interface DeliveryStore {
	/**
	 * Whether a delivery for `gatewayRef` is already recorded. The `payment`
	 * table's UNIQUE (gateway, gateway_ref) index (migration 0025) is the
	 * durable "one ref = one grant" stopper; this seam returns its answer.
	 */
	seen(gatewayRef: string): Promise<boolean>;
}

export interface ClaimContext {
	nonces: NonceStore;
	delivery: DeliveryStore;
}

export type ClaimResult =
	| { ok: true; state: 'claimed' | 'existing' }
	| { ok: false; reason: 'replay' | 'missing_ref' | 'missing_nonce' };

/**
 * Claim one delivery against the nonce and the gatewayRef idempotency anchors.
 *
 * Order matters:
 *   - `seen(gatewayRef)` first: an already-recorded ref is the idempotent case —
 *     the callback is genuine but the money already moved, so return `existing`
 *     WITHOUT burning a nonce (a redelivery that re-mints nothing).
 *   - `nonces.claim` second: a replayed nonce (a fresh ref but a reused nonce)
 *     is refused — this is the anti-replay gate.
 */
export async function claimDelivery(
	ctx: ClaimContext,
	gatewayRef: string,
	nonce: string,
	windowMs: number
): Promise<ClaimResult> {
	if (typeof gatewayRef !== 'string' || gatewayRef.trim() === '') {
		return { ok: false, reason: 'missing_ref' };
	}
	if (typeof nonce !== 'string' || nonce.trim() === '') {
		return { ok: false, reason: 'missing_nonce' };
	}

	if (await ctx.delivery.seen(gatewayRef)) {
		return { ok: true, state: 'existing' };
	}

	const first = await ctx.nonces.claim(nonce, windowMs);
	if (!first) return { ok: false, reason: 'replay' };

	return { ok: true, state: 'claimed' };
}

// ---------------------------- assertInboundPublic ----------------------------

export interface AssertPublicFn {
	(url: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface InboundAssertPublicContext {
	/** Wired to `assertPublicUpstream` (./ssrf.ts) by the transport. */
	assertPublic: AssertPublicFn;
}

export type AssertInboundPublicResult =
	| { ok: true }
	| { ok: false; reason: 'missing_verify_url' | string };

/**
 * Guard the inbound callback's validate-back URL. The "inbound SSRF" concern is
 * really an OUTBOUND one: a `verify_url` embedded in the callback would make us
 * fetch a URL an attacker picked, so it MUST pass `assertPublicUpstream`
 * (./ssrf.ts) before any dial — the same rule the outbound webhook delivery and
 * provider fetches use, and itself complete (literal private ranges + a full DNS
 * resolution of every address). No inbound-only guard is needed: the thing being
 * guarded is the URL, and there is exactly one correct rule for it.
 */
export async function assertInboundPublic(
	ctx: InboundAssertPublicContext,
	url: string | null | undefined
): Promise<AssertInboundPublicResult> {
	const u = typeof url === 'string' ? url.trim() : '';
	if (!u) return { ok: false, reason: 'missing_verify_url' };
	const guard = await ctx.assertPublic(u);
	return guard.ok ? { ok: true } : { ok: false, reason: guard.reason };
}

// --------------------------- HTTP status mapping -----------------------------

/** Map a verify/claim refusal to the HTTP status the route answers with. */
export function httpStatusForReject(
	reason: InboundRejectReason | 'replay' | 'missing_ref' | 'missing_nonce'
): number {
	switch (reason) {
		case 'bad_signature':
			return 401;
		case 'replay':
		case 'stale_timestamp':
			return 409;
		case 'not_settled':
			// A genuine callback that is merely not settled must be ACKed (200)
			// so the gateway does not retry a body it already delivered honestly.
			return 200;
		case 'bad_body':
		case 'missing_ref':
		case 'missing_nonce':
		case 'bad_timestamp':
		case 'missing_amount':
		default:
			return 400;
	}
}