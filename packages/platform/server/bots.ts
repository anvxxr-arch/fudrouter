// packages/platform/server/bots.ts — the Discord + Telegram bot core.
//
// Owner directive (docs/specs/2026-10-31-subscription-platform-target.md):
//
//   3.  Discord bot payments
//   4.  Telegram bot payments
//   16. auto-warn members via API, Telegram and Discord
//   17. Discord + Telegram marketplace
//   21. the admin approval flow: the bot asks @zupaxx "did the user really make
//       this transaction? this is the image reference" with Yes/No buttons;
//       Yes publishes the member's key, No follows up.
//
// Why the logic is here and the transport is not: the DECISIONS (which plan,
// whether to grant, what to warn, what to list) are the same for both bots and
// must be unit-testable without a network. Each bot is a thin adapter that
// turns a platform update into a call on this module and renders the reply.
// That split is the same one `publish.ts` / `publish-env.ts` uses.
//
// The module is pure: no fetch, no DB, no clock beyond what the caller injects.
// The adapters (discord-bot.ts, telegram-bot.ts) own the I/O.

import { PLANS, PLAN_IDS, planOf, qrisFor, resolveGrant, approvalAction } from './payments.ts';

/** A member-facing plan list, rendered identically by both bots. */
export interface PlanLine {
	id: string;
	label: string;
	days: number;
	priceIdr: number;
}

/** The five plans as a list, cheapest first — the marketplace/pricing payload. */
export function planLines(): PlanLine[] {
	return PLAN_IDS.map((id) => ({ id, ...PLANS[id] }));
}

/** Format rupiah the way an Indonesian member reads it: `Rp 30.000`. */
export function formatIdr(amount: number): string {
	return 'Rp ' + Math.round(amount).toLocaleString('id-ID');
}

/**
 * The message a member sees when they pick a plan: the QRIS payload to pay and
 * the amount. Returns `null` for an unknown plan so the caller can answer
 * "unknown plan" rather than render a broken QR.
 */
export function paymentPrompt(planId: string): { text: string; qris: string; amountIdr: number } | null {
	const plan = planOf(planId);
	if (!plan) return null;
	const qris = qrisFor(plan.priceIdr);
	if (!qris) return null;
	return {
		amountIdr: plan.priceIdr,
		qris,
		text:
			`Plan: ${plan.label} (${plan.days} day${plan.days > 1 ? 's' : ''})\n` +
			`Amount: ${formatIdr(plan.priceIdr)}\n\n` +
			`Pay the QRIS below, then send the payment proof here. ` +
			`An admin will confirm it and your API key will be published.`
	};
}

/**
 * The admin approval prompt (rule 21). `member` is a display name, `proofUrl`
 * the image reference the member sent. The two buttons map to `yes`/`no`.
 */
export function adminApprovalPrompt(member: string, planId: string, proofUrl: string): {
	text: string;
	buttons: { id: 'yes' | 'no'; label: string }[];
} {
	const plan = planOf(planId);
	const amount = plan ? formatIdr(plan.priceIdr) : 'unknown amount';
	return {
		text:
			`Payment claim from ${member}\n` +
			`Plan: ${planId} (${amount})\n` +
			`Reference: ${proofUrl || '(no image)'}\n\n` +
			`Did this user really make the transaction? This is the image reference.`,
		buttons: [
			{ id: 'yes', label: 'Yes, real — publish key' },
			{ id: 'no', label: 'No — follow up' }
		]
	};
}

/**
 * The follow-up message when the admin answers "no" (rule 21). It names the
 * plan and the amount so the member can complete the payment without asking.
 */
export function followUpMessage(planId: string): string {
	const plan = planOf(planId);
	if (!plan) return 'We could not confirm your payment. Please contact support.';
	return (
		`We could not confirm your payment for ${plan.label} (${formatIdr(plan.priceIdr)}). ` +
		`Please complete the QRIS payment and send the proof again.`
	);
}

/**
 * The warning text for a member (rule 16). `kind` is the entitlement rule that
 * fired; the text is what the member reads on whichever channel delivered it.
 */
export function warningText(kind: string, detail = ''): string {
	const base: Record<string, string> = {
		ip_limit: 'Your API key was used from more than 3 IP addresses.',
		concurrency: 'Your API key exceeded 5 concurrent requests.',
		subscription_expired: 'Your subscription has expired.',
		no_subscription: 'You do not have an active subscription.',
		key_restricted: 'Your API key has been restricted.'
	};
	const head = base[kind] ?? 'There is an issue with your account.';
	return detail ? `${head} ${detail}` : head;
}

/**
 * The marketplace listing (rule 17): the plans, as both bots render them.
 * A single source so Discord and Telegram cannot show different prices.
 */
export function marketplaceListing(): { title: string; items: PlanLine[] } {
	return { title: 'Subscription plans', items: planLines() };
}

/**
 * Decide what a payment claim does, given the admin's answer (rule 21).
 *
 * This is the one function that turns a button press into an action, so it is
 * pure and pinned by the four-case test. It composes `approvalAction` (the
 * fail-closed button mapping) with `resolveGrant` (the money rule) so a "yes"
 * on a short payment still does not grant.
 */
export function decideClaim(
	payment: { plan: string; status: string; amountIdr: number },
	answer: string,
	now = new Date()
): { grant: boolean; publishKey: boolean; followUp: boolean; reason: string } {
	const action = approvalAction(answer);
	if (!action.grant) {
		return { grant: false, publishKey: false, followUp: true, reason: 'admin_declined' };
	}
	// The admin said yes; the money rule still has to agree. A confirmed status
	// is set by the caller from the admin's answer, so we pass it through.
	const grant = resolveGrant({ ...payment, status: 'confirmed' }, now);
	if (!grant.ok) {
		return { grant: false, publishKey: false, followUp: true, reason: grant.reason };
	}
	return { grant: true, publishKey: true, followUp: false, reason: 'granted' };
}
