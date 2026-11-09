// packages/platform/server/discord-bot.ts — the Discord payment bot adapter (C2).
//
// This module is the THIN I/O half of the Discord payments surface (owner
// rules 3, 16, 17, 21). It is deliberately NOT the same module as
// apps/web/server/lib/discord.mjs `joinFudcourt`: that one manipulates guild
// MEMBERSHIP after sign-in (PUT /guilds/{guild}/members/{user}); this one turns
// a Discord slash-command or button update into a call on bots.ts and renders
// the reply.
//
// The DECISIONS live in packages/platform/server/bots.ts (plan list, prices,
// QRIS prompt, admin approval prompt, follow-up, claim decision) and
// packages/platform/server/payments.ts (planOf). This module copies NONE of
// that: it only maps a Discord update onto the right core call and renders the
// result, so Discord and Telegram — which share the same core — can never show
// different prices or wording (criterion 4).
//
// Transport is injected (DiscordReply / DiscordSend) and so is the confirm→grant
// seam (DiscordGrant), which the gateway wires to B3b's `confirmAndGrant`
// (payment-confirm.ts → grantForPayment → resolveGrant). WHO may press the
// button (C2) is `ctx.approverUsers`, the Discord USER-id allow-list — empty
// means every actor is refused. The adapter runs WITHOUT a network or database:
// tests inject fake reply/send/confirm recorders.

import {
	paymentPrompt,
	adminApprovalPrompt,
	followUpMessage,
	decideClaim,
	plansMessage,
	unknownPlanMessage
} from './bots.ts';
import { planOf } from './payments.ts';

// ------------------------------ transport ---------------------------------

/** Reply to the interaction that triggered this update. */
export type DiscordReply = (interaction: DiscordInteraction, message: string) => Promise<void> | void;

/** Send a message to an ARBITRARY channel (admin channel, or member DM). */
export type DiscordSend = (channelId: string, message: string) => Promise<void> | void;

// ------------------------------- update -----------------------------------

/** A slash-command or button update from Discord, normalized by the gateway. */
export interface DiscordInteraction {
	/** Discord interaction id (kept for the reply; not used by the adapter). */
	id: string;
	/** Discord snowflake of the acting user — the C2 actor identity. */
	userId: string;
	/** Display name of the acting user — feeds the admin prompt. */
	userDisplayName: string;
	/** Where the interaction fired (usually the user's DM or the admin channel). */
	channelId: string;
	/** Where member-facing messages go (a DM / the member's guild channel).
	 * Distinct from `channelId` so a "no" follow-up reaches the MEMBER, not the
	 * admin channel the button was clicked in. */
	memberChannelId?: string;
	/** The slash command invoked: 'plans' | 'pay'. */
	commandName?: string;
	/** The /pay plan id option. */
	planId?: string;
	/** Attachments on a proof-upload message (first is the proof image). */
	attachments?: { url: string }[];
	/** The message-component custom id for an admin approve button. */
	componentId?: string;
}

// ------------------------------ render (pure) ------------------------------

/** /plans render — the exact string Telegram emits (plansMessage, one core). */
export function renderPlans(): string {
	return plansMessage();
}

/** /pay render. `ok:false` carries the unknown-plan refusal (reusing planOf). */
export function renderPay(
	planId: string
):
	| { ok: true; text: string; qris: string; amountIdr: number }
	| { ok: false; text: string } {
	if (!planOf(planId)) {
		return { ok: false, text: unknownPlanMessage() };
	}
	const prompt = paymentPrompt(planId);
	if (!prompt) {
		// Unreachable for a planOf-accepted plan (qrisFor null means the pinned
		// merchant payload is malformed); fail clean rather than crash.
		return { ok: false, text: unknownPlanMessage() };
	}
	return { ok: true, text: prompt.text, qris: prompt.qris, amountIdr: prompt.amountIdr };
}

/** Encode an admin Yes/No button's Discord custom id. */
export function approvalCustomId(answer: 'yes' | 'no', paymentId: string): string {
	return `approval:${answer}:${paymentId}`;
}

/** Decode an admin approval button custom id; null when it is not one of ours. */
export function parseApprovalCustomId(
	customId: string | undefined | null
): { answer: 'yes' | 'no'; paymentId: string } | null {
	const m = /^approval:(yes|no):(.+)$/.exec(String(customId ?? '').trim());
	if (!m) return null;
	return { answer: m[1] as 'yes' | 'no', paymentId: m[2] };
}

/** The admin approval prompt (core) plus its Yes/No button custom ids. */
export function renderApproval(
	member: string,
	paymentId: string,
	planId: string,
	proofUrl: string
): { text: string; yesId: string; noId: string } {
	const prompt = adminApprovalPrompt(member, planId, proofUrl);
	return {
		text: prompt.text,
		yesId: approvalCustomId('yes', paymentId),
		noId: approvalCustomId('no', paymentId)
	};
}
// ------------------------------ effect seams --------------------------------

/** The payment facts an admin approval decides on, resolved by the transport
 * from the payment id encoded in the button. */
export interface DiscordPaymentClaim {
	paymentId: string;
	plan: string;
	amountIdr: number;
	status: string;
}

export type DiscordGrantResult =
	| { ok: true; subscriptionId: string; plan: string; days: number }
	| { ok: false; reason: string };

/**
 * The confirm→grant seam. The gateway wires this to
 * payment-confirm.ts `confirmAndGrant` (→ grantForPayment → resolveGrant), which
 * re-runs the money rule and persists ONE confirmed payment + ONE `frsubs`
 * window. The adapter decides via `decideClaim` and hands a "yes" here.
 */
export interface DiscordGrant {
	confirmAndGrant(payment: DiscordPaymentClaim): Promise<DiscordGrantResult>;
}

/**
 * The claim-recording seam. The gateway wires this to the ONE shared write
 * (packages/platform/server/claim.ts `drizzleClaimWriter(db).record`) so the
 * Discord, Telegram and web surfaces never diverge on what "claimed" means.
 */
export interface DiscordClaimRecorder {
	record(paymentId: string, proofUrl: string): Promise<{ ok: boolean }>;
}

export interface DiscordBotContext {
	reply: DiscordReply;
	send: DiscordSend;
	grant: DiscordGrant;
	claim?: DiscordClaimRecorder;
	/**
	 * The approver channels that receive the approval prompt, in escalation
	 * order: `approvers[0]` is the primary, `approvers[1]` the first fallback —
	 * same rule and same env source as the Telegram adapter, so both channels
	 * share one escalation contract (approval.ts). These are PROMPT
	 * DESTINATIONS (channel ids), NOT the human's identity.
	 */
	approvers: string[];
	/**
	 * The Discord USER ids allowed to press the approve button (C2). Empty or
	 * absent => EVERY actor is refused (fail-closed deny-all). Distinct from
	 * `approvers`: that list routes the prompt, this one authorizes the actor.
	 */
	approverUsers: string[];
	/** Frozen clock for `decideClaim` (tests only; defaults to wall clock). */
	now?: Date;
	/** Persist WHO answered + WHEN into raw.approval (C3). Wired to claim.ts. */
	answerApproval?(paymentId: string, answeredBy: string, answeredAt: number): Promise<void>;
	/** Flip a still-open payment to 'rejected' on a "no" (C3). Wired to claim.ts. */
	rejectPayment?(paymentId: string): Promise<void>;
}

// ------------------------------ handlers -----------------------------------

/** `/plans` — the marketplace list, rendered identically to Telegram. */
export async function handlePlans(
	interaction: DiscordInteraction,
	ctx: DiscordBotContext
): Promise<void> {
	await ctx.reply(interaction, renderPlans());
}

/** `/pay <planId>` — the QRIS prompt, or the unknown-plan refusal. */
export async function handlePay(
	interaction: DiscordInteraction,
	ctx: DiscordBotContext
): Promise<void> {
	await ctx.reply(interaction, renderPay(interaction.planId ?? '').text);
}

/** Member uploaded payment proof — record the claim and prompt the primary. */
export async function handleProof(
	interaction: DiscordInteraction,
	ctx: DiscordBotContext,
	proof: { planId: string; paymentId: string }
): Promise<void> {
	const proofUrl = interaction.attachments?.[0]?.url ?? '';
	const prompt = renderApproval(
		interaction.userDisplayName,
		proof.paymentId,
		proof.planId,
		proofUrl
	);
	if (ctx.claim) await ctx.claim.record(proof.paymentId, proofUrl);

	// B5: the primary approver gets the prompt; no approver -> fail closed.
	const approver = ctx.approvers[0];
	if (!approver) {
		await ctx.reply(interaction, 'Proof received. No approver is configured to confirm it yet.');
		return;
	}
	await ctx.send(approver, prompt.text);
	await ctx.reply(
		interaction,
		'Proof received. An admin will confirm it and publish your API key.'
	);
}

/** True when `userId` may adjudicate (C2). Empty allow-list => deny all. */
function actorAuthorized(userId: string, approverUsers: string[] | undefined): boolean {
	if (!userId) return false;
	const allowed = approverUsers ?? [];
	return allowed.length > 0 && allowed.includes(userId);
}

/** Admin approve button Yes/No — authorize the actor (C2), then decide + act. */
export async function handleApproval(
	interaction: DiscordInteraction,
	answer: 'yes' | 'no',
	payment: DiscordPaymentClaim,
	ctx: DiscordBotContext
): Promise<void> {
	// C2: only an allow-listed Discord user may adjudicate; a non-approver who
	// sees the button is refused before any money decision.
	if (!actorAuthorized(interaction.userId, ctx.approverUsers)) {
		await ctx.reply(interaction, 'You are not an approver.');
		return;
	}

	const now = ctx.now ?? new Date();
	const answeredAt = now.getTime();

	// C3: record WHO answered and WHEN before deciding.
	await ctx.answerApproval?.(payment.paymentId, interaction.userId, answeredAt);

	const decision = decideClaim(
		{ plan: payment.plan, status: payment.status, amountIdr: payment.amountIdr },
		answer,
		now
	);

	if (decision.grant) {
		const outcome = await ctx.grant.confirmAndGrant(payment);
		if (outcome.ok) {
			await ctx.reply(
				interaction,
				`Approved — ${outcome.plan} subscription granted (${outcome.days} days).`
			);
		} else {
			await ctx.reply(interaction, `Could not grant: ${outcome.reason}`);
		}
	} else {
		// "no" (admin_declined) or "yes on a short/unknown plan" (fail-closed
		// money rule): a "no" also flips the claim to 'rejected' (C3) so the
		// escalation loop stops re-prompting.
		if (decision.reason === 'admin_declined') {
			await ctx.rejectPayment?.(payment.paymentId);
		}
		await ctx.reply(interaction, `Not approved (${decision.reason}).`);
		await ctx.send(
			interaction.memberChannelId ?? interaction.channelId,
			followUpMessage(payment.plan)
		);
	}
}