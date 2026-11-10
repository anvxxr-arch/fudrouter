// packages/platform/server/mayar-create.ts — the additive Mayar create path.
//
// The legacy `createPayment` (gateway.ts) is the ONLY writer for the static
// `qris-native` path and is left untouched. This module adds a SECOND, parallel
// entry point for the Mayar gateway: the same plan/amount/channel validation,
// the same idempotency anchor (`gatewayRefFor` → `purchase:<key>` on the durable
// UNIQUE (gateway, gateway_ref)), but the outbound step is `MayarClient.createPayment`
// and the member artefact is the checkout URL (`data.link`), not a raw QRIS.
//
// Fail-closed (FR-revised M3): when `client` is null (MAYAR_API_KEY unset) this
// function delegates to the legacy `createPayment` with the DEFAULT store, so
// the static-QR behaviour is byte-for-byte unchanged. The caller supplies BOTH
// stores precisely so this fallback cannot be forgotten: `mayarStore` is scoped
// to `mayar`, `legacyStore` to `GATEWAY_DEFAULT`.
//
// Persistence (B1): the vendor's create facts (`data.id`, `transactionId`,
// `link`) are persisted verbatim onto `payment.raw.mayar` via `updateRaw`, so the
// settlement path matches on WHAT WE WROTE — never on a re-parsed `extraData`
// out of a webhook body.

import {
	createPayment,
	gatewayRefFor,
	type CreatePaymentResult,
	type PaymentRecord
} from './gateway.ts';
import { isChannel, planOf } from './payments.ts';
import { MAYAR_GATEWAY, type MayarClient, type MayarErrorKind } from './mayar.ts';
import type { MayarGatewayStore } from './gateway-store.ts';
import { MAYAR_RAW_KEY, mayarCheckoutUrlOf } from './mayar-settlement.ts';

/** The legacy reject vocabulary, kept so the two create paths refuse identically. */
export type MayarCreateRejectReason =
	| Extract<CreatePaymentResult, { ok: false }>['reason']
	| MayarErrorKind;

export type MayarCreatePaymentResult =
	| {
			ok: true;
			gatewayRef: string;
			/** The member's checkout URL (`data.link`); null on the fallback path. */
			checkoutUrl: string | null;
			/** The static QRIS payload; present only on the fallback (legacy) path. */
			qr: string | null;
			record: PaymentRecord;
			state: 'created' | 'existing';
	  }
	| { ok: false; reason: MayarCreateRejectReason };

export interface MayarCreatePaymentInput {
	accountId: string;
	channel: string;
	plan: string;
	amountIdr: number;
	idempotencyKey: string;
	email?: string;
	redirectUrl?: string;
	expiredAt?: Date;
}

export interface MayarCreatePaymentContext {
	/** The gateway-store scoped to `MAYAR_GATEWAY` ('mayar'). */
	mayarStore: MayarGatewayStore;
	/** The legacy store scoped to `GATEWAY_DEFAULT`, used only when no key exists. */
	legacyStore: MayarGatewayStore;
	/** Mayar client, or null when MAYAR_API_KEY is unset (the fail-closed switch). */
	client: MayarClient | null;
}

/**
 * Create a Mayar payment attempt, falling back to the legacy static-QR path when
 * the gateway is not configured. Idempotent on `gatewayRefFor(idempotencyKey)`:
 * a retry reproduces the first intent's record and (for the Mayar path) its
 * persisted checkout URL.
 */
export async function createMayarPayment(
	ctx: MayarCreatePaymentContext,
	input: MayarCreatePaymentInput
): Promise<MayarCreatePaymentResult> {
	// No key: the Mayar function is never called; the legacy static-QR path is
	// reproduced in full through the SAME `createPayment` decision.
	if (!ctx.client) {
		const legacy = await createPayment({ store: ctx.legacyStore }, input);
		if (!legacy.ok) return { ok: false, reason: legacy.reason };
		return {
			ok: true,
			gatewayRef: legacy.gatewayRef,
			checkoutUrl: null,
			qr: legacy.qr,
			record: legacy.record,
			state: legacy.state
		};
	}

	const key = String(input.idempotencyKey ?? '').trim();
	if (!key) return { ok: false, reason: 'missing_idempotency_key' };

	if (!planOf(input.plan)) return { ok: false, reason: 'unknown_plan' };
	if (!isChannel(input.channel)) return { ok: false, reason: 'invalid_channel' };

	const amount = Number(input.amountIdr);
	if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
		return { ok: false, reason: 'invalid_amount' };
	}

	const gatewayRef = gatewayRefFor(key);

	// Row-first (FR-revised S5): the idempotency anchor is OURS, before the
	// vendor call. A retry finds the row and never dials the vendor again.
	const existing = await ctx.mayarStore.findPayment(gatewayRef);
	if (existing) {
		return {
			ok: true,
			gatewayRef,
			checkoutUrl: mayarCheckoutUrlOf(existing.raw) ?? null,
			qr: null,
			record: existing,
			state: 'existing'
		};
	}

	const record = await ctx.mayarStore.insertPayment({
		gatewayRef,
		gateway: MAYAR_GATEWAY,
		accountId: input.accountId,
		channel: input.channel,
		plan: input.plan,
		amountIdr: amount,
		status: 'pending'
	});

	const created = await ctx.client.createPayment({
		name: `FUDRouter ${input.plan}`,
		amount,
		email: input.email,
		redirectUrl: input.redirectUrl,
		expiredAt: input.expiredAt
	});
	if (!created.ok) {
		return { ok: false, reason: created.kind };
	}

	// B1: persist what the vendor told US, so settlement binds on OUR write.
	const raw = {
		[MAYAR_RAW_KEY]: {
			id: created.value.id,
			transactionId: created.value.transactionId,
			link: created.value.link
		}
	};
	await ctx.mayarStore.updateRaw(record.id, raw);

	return {
		ok: true,
		gatewayRef,
		checkoutUrl: created.value.link,
		qr: null,
		record: { ...record, raw },
		state: 'created'
	};
}