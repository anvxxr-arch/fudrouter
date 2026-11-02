// packages/platform/server/payments.ts — the subscription payment core.
//
// Owner directive (docs/specs/2026-10-31-subscription-platform-target.md):
// members buy TIME (1d/3d/7d/14d/28d in IDR), not tokens, and settlement is
// MANUAL — a QRIS dynamic payment that an operator confirms (rules 20, 21).
//
// This module owns the three things that must be right for money to be safe:
//
//   1. the PLAN TABLE — the five priced plans, in one place, so a bot command,
//      a web checkout and an admin comp cannot disagree about what `sub_7d`
//      costs;
//   2. the QRIS PAYLOAD BUILDER — injecting the amount into the owner's pinned
//      merchant payload (tag 54) per the QRIS dynamic spec;
//   3. the GRANT RULE — turning an admin-confirmed payment into a subscription
//      window, idempotently, so a double-tap on the approval button grants once.
//
// Why the plan table is a frozen constant and not a DB row: the owner priced
// exactly five plans. A DB row would let a typo mint an unpriced entitlement,
// and the migration's CHECK constraint already pins the same five names. Two
// sources of truth for a price is one too many; the constant is the source and
// the CHECK is the backstop.

/** One priced plan. `days` drives the window; `priceIdr` is whole rupiah. */
export interface Plan {
	days: number;
	priceIdr: number;
	label: string;
}

/** The five plans the owner priced. */
export const PLANS: Readonly<Record<string, Plan>> = Object.freeze({
	sub_1d: { days: 1, priceIdr: 5000, label: '1 Day' },
	sub_3d: { days: 3, priceIdr: 12000, label: '3 Days' },
	sub_7d: { days: 7, priceIdr: 30000, label: '7 Days' },
	sub_14d: { days: 14, priceIdr: 50000, label: '14 Days' },
	sub_28d: { days: 28, priceIdr: 90000, label: '28 Days' }
});

/** The plan ids in display order (cheapest first). */
export const PLAN_IDS: readonly string[] = Object.freeze(Object.keys(PLANS));

/**
 * The owner's pinned merchant QRIS payload (rule 20). It is a STATIC payload —
 * it carries no amount — so `qrisFor` injects tag 54 before it can be paid.
 *
 * Pinned as a constant, not an env var: the owner supplied one merchant
 * identity, and a typo in an env var would send money to the wrong account.
 */
export const QRIS_MERCHANT_PAYLOAD =
	'00020101021126610014COM.GO-JEK.WWW01189360091439738305930210G9738305930303UMI51440014ID.CO.QRIS.WWW0215ID10243394679450303UMI5204733353033605802ID5919LEV. SPACE, Jakarta6005TUBAN61056238262070703A0163049B3A';

/**
 * Resolve a plan id to its definition.
 *
 * Returns `null` for an unknown id rather than throwing: a bot command with a
 * typo must answer "unknown plan", not crash the handler. The caller decides
 * whether that is a 400 or a chat reply.
 */
export function planOf(id: string | undefined | null): Plan | null {
	if (!id) return null;
	return PLANS[id] ?? null;
}

/**
 * Build a QRIS dynamic payload for `amountIdr` from the pinned merchant payload.
 *
 * QRIS is EMVCo TLV: `[2-digit tag][2-digit length][value]`. The amount lives
 * in tag 54 as a decimal string. A static payload has no tag 54, so this
 * inserts one immediately before tag 58 (country code), which is where the
 * spec places it, and recomputes tag 63 (CRC-16/CCITT-FALSE) over the result.
 *
 * Returns `null` for a non-positive amount — a zero-rupiah QRIS is not a
 * payment, and minting one would let a member "pay" nothing.
 */
export function qrisFor(amountIdr: number | string): string | null {
	const amount = Number(amountIdr);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const amountField = tlv('54', String(Math.round(amount)));
	// Insert before tag 58 (country). If 58 is absent the payload is not a QRIS
	// we recognise, so refuse rather than append blindly.
	const idx = QRIS_MERCHANT_PAYLOAD.indexOf('5802ID');
	if (idx < 0) return null;
	const body = QRIS_MERCHANT_PAYLOAD.slice(0, idx) + amountField + QRIS_MERCHANT_PAYLOAD.slice(idx);
	// Tag 63 is the CRC: strip any existing one, then append the recomputed value.
	const withoutCRC = body.replace(/6304[0-9A-Fa-f]{4}$/, '');
	const withTag = withoutCRC + '6304';
	return withTag + crc16(withTag);
}

/** Encode one EMVCo TLV field: 2-digit tag, 2-digit length, value. */
function tlv(tag: string, value: string): string {
	const len = String(value.length).padStart(2, '0');
	return `${tag}${len}${value}`;
}

/**
 * CRC-16/CCITT-FALSE, the checksum EMVCo tag 63 uses. Polynomial 0x1021,
 * init 0xFFFF, no reflection, no final xor. Returns 4 uppercase hex digits.
 */
export function crc16(input: string): string {
	let crc = 0xffff;
	for (let i = 0; i < input.length; i++) {
		crc ^= input.charCodeAt(i) << 8;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
		}
	}
	return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** A payment as the grant rule sees it. */
export interface PaymentInput {
	plan: string;
	status: string;
	amountIdr: number;
}

/** The result of the grant rule. */
export type GrantResult =
	| { ok: true; plan: string; days: number; priceIdr: number; expiresAt: Date }
	| { ok: false; reason: string };

/**
 * The grant rule: given an admin-CONFIRMED payment, what subscription window
 * results?
 *
 * Pure — no DB, no clock beyond the injected `now` — so the four-case test can
 * pin every branch. Returns `{ ok: false, reason }` for anything that must not
 * grant, and `{ ok: true, ... }` for a grant.
 *
 * The refusals are the ways money can be wrong:
 *   - unknown plan      -> never grant (a typo must not mint entitlement)
 *   - amount mismatch   -> never grant (a member who under-paid is a bug, not
 *                          a discount; the admin is told to follow up)
 *   - not confirmed     -> never grant (pending/rejected are not money)
 */
export function resolveGrant(payment: PaymentInput | null | undefined, now: Date = new Date()): GrantResult {
	if (!payment || typeof payment !== 'object') {
		return { ok: false, reason: 'no_payment' };
	}
	const plan = planOf(payment.plan);
	if (!plan) {
		return { ok: false, reason: 'unknown_plan' };
	}
	if (payment.status !== 'confirmed') {
		return { ok: false, reason: 'not_confirmed' };
	}
	// The admin confirms the amount they saw on the member's proof. A mismatch
	// is a hard stop: granting on a short payment gives away service.
	if (Number(payment.amountIdr) !== plan.priceIdr) {
		return { ok: false, reason: 'amount_mismatch' };
	}
	const expiresAt = new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000);
	return { ok: true, plan: payment.plan, days: plan.days, priceIdr: plan.priceIdr, expiresAt };
}

/**
 * The channels a payment can arrive through (owner features 3, 4, 17).
 * Kept as a set so a bot command and the web checkout validate identically.
 */
export const CHANNELS: readonly string[] = Object.freeze(['web', 'discord', 'telegram', 'admin']);

/** True when `channel` is one the platform accepts. */
export function isChannel(channel: string | undefined | null): boolean {
	return !!channel && CHANNELS.includes(channel);
}

/**
 * The admin approval decision (owner rule 21). The bot asks the admin with two
 * buttons; this maps the button to the next action.
 *
 *   yes -> grant the subscription and publish the member's key
 *   no  -> follow up with the member to complete payment
 *
 * An unknown answer is treated as "no" (fail closed): a mis-tapped or spoofed
 * callback must never publish a key.
 */
export function approvalAction(answer: string | undefined | null): {
	grant: boolean;
	publishKey: boolean;
	followUp: boolean;
} {
	if (answer === 'yes') return { grant: true, publishKey: true, followUp: false };
	return { grant: false, publishKey: false, followUp: true };
}
