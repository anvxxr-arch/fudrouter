// packages/platform/server/telegram-bot.ts — the Telegram bot adapter (C1).
//
// This file is THIN I/O. It owns only the Telegram-shaped inputs/outputs and the
// seams that touch Telegram or Postgres; every DECISION is delegated to the
// shared core, never re-made here:
//
//   - which plans exist / what a plan costs  -> bots.ts paymentPrompt / plansMessage
//   - formatting rupiah                       -> bots.ts formatIdr
//   - the unknown-plan reply                  -> bots.ts unknownPlanMessage
//   - whether the admin's answer grants       -> bots.ts decideClaim (pure)
//   - minting a pending payment               -> gateway.ts createPayment (B1)
//   - confirm → grant (idempotent, frsubs)    -> payment-confirm.ts confirmAndGrant (B3b),
//                                               which reaches grantForPayment → resolveGrant
//   - WHICH approver holds the prompt (B5)    -> approval.ts approvalRoute / escalate
//
// The split matches bots.ts's header (DECISIONS here, adapters own I/O) and the
// "core ≠ transport" pattern gateway.ts uses: `TelegramBotDeps` carries the
// Telegram senders and the money seams, so the four-case test runs against
// in-memory fakes with no network, no database and no DATABASE_URL.
//
// The one seam below that is NOT a shared decision function is `recordClaim`
// (member proof → payment.status 'claimed'). There is no shared claim writer
// yet — the web checkout does it inline in apps/web/server/pages.mjs. Rather than
// mint a second writer here (out of C1's ownership), the adapter declares the
// seam and the bot's transport wires it to that existing checkout path.

import {
	plansMessage,
	unknownPlanMessage,
	formatIdr,
	paymentPrompt,
	adminApprovalPrompt,
	followUpMessage,
	warningText,
	decideClaim
} from './bots.ts';
import { planOf } from './payments.ts';
import { createPayment, type GatewayStore } from './gateway.ts';
import {
	confirmAndGrant,
	type PaymentConfirmRecord,
	type PaymentConfirmStore
} from './payment-confirm.ts';
import type { SubscriptionWriter } from './grant.ts';

// ---------------------------------------------------------------------------
// transport — the only Telegram-shaped I/O the adapter performs.
// ---------------------------------------------------------------------------

/** Options a send may carry. `qris` and `claim` are hints the transport renders. */
export interface TelegramSendOptions {
	/** Inline keyboard buttons; the button `id` is the callback data (`yes`/`no`). */
	buttons?: { id: string; label: string }[];
	/** The QRIS payload string, present only for /pay. */
	qris?: string;
	/** The claim these buttons resolve to; the transport encodes it into callback data. */
	claim?: TelegramClaim;
}

/** Send one message to a chat. */
export interface TelegramSend {
	(chatId: string, text: string, opts?: TelegramSendOptions): Promise<void>;
}

/** Answer a callback query (dismisses the inline button's spinner). */
export interface TelegramAnswerCallback {
	(callbackId: string, text: string): Promise<void>;
}

/** A member message as the Telegram transport normalises it. */
export interface TelegramMessage {
	/** The chat the message arrived from (the member's chat). */
	chatId: string;
	/** The member's display handle, used in the admin prompt ("from @x"). */
	username?: string;
	/** Telegram update id — the idempotency token for minting the payment. */
	updateId: number;
	/** The `/command` text, when the message is a command. */
	text?: string;
	/** The payment-proof photo, when the member uploaded one. */
	photo?: { fileId: string; url?: string };
}

/**
 * The claim identity a callback resolves to. Deliberately only `paymentId` and
 * (untrusted, transport-encoded) display facts: `paymentId` is the idempotency
 * anchor, and everything money-relevant is re-fetched by `resolveClaim` from the
 * trusted store — a tampered callback can never mint or redirect a grant.
 */
export interface TelegramClaim {
	paymentId: string;
	memberChatId: string;
	memberName: string;
}

/** A callback query (the admin pressing Yes/No) as the transport normalises it. */
export interface TelegramCallbackQuery {
	/** callback_query.id, for the `answerCallback` ack. */
	id: string;
	/** The raw callback data; the transport decodes `answer` and `claim` from it. */
	data: string;
	/** `yes` / `no` (anything else is fail-closed to follow-up). */
	answer: string;
	claim: TelegramClaim;
}

// ---------------------------------------------------------------------------
// seams — everything the adapter needs but does not implement.
// ---------------------------------------------------------------------------

/** A pending payment's claim facts, resolved by the transport (latest pending). */
export interface PendingPayment {
	paymentId: string;
	planId: string;
}

export interface TelegramBotDeps {
	send: TelegramSend;
	answerCallback: TelegramAnswerCallback;
	/**
	 * The approver chats that receive the approval prompt, in escalation order:
	 * `approvers[0]` is the primary, `approvers[1]` the first fallback, and so
	 * on (owner rule 8/21; escalation rule S9/P1.3). One list — a single source
	 * of truth — populated from `FUDROUTER_APPROVERS` by the transport (see
	 * approval-env.ts). Empty means no approver is configured: fail closed,
	 * the proof is still recorded but no prompt is sent.
	 */
	approvers: string[];
	/** Frozen clock for tests; defaults to wall clock. */
	now?: () => Date;
	/** Member chat → platform account id. Owned by the transport (Telegram OAuth link). */
	accountIdFor(chatId: string): Promise<string | null>;
	/** The member's latest pending payment, to attach a proof to. */
	findPendingPayment(accountId: string): Promise<PendingPayment | null>;
	/** Record the member's proof against a payment (transport wires the existing claim path). */
	recordClaim(args: { paymentId: string; proofUrl: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Re-fetch the payment row behind a claim id (trusted store), or null when gone. */
	resolveClaim(paymentId: string): Promise<PaymentConfirmRecord | null>;
	/** gateway.createPayment's store (B1) — mints the pending payment row. */
	gatewayStore: GatewayStore;
	/** payment-confirm.confirmAndGrant's store (B3b). */
	paymentConfirmStore: PaymentConfirmStore;
	/** grant.ts SubscriptionWriter (B2) — persists the frsubs window. */
	subscriptionWriter: SubscriptionWriter;
}

/** The single approver that currently holds the prompt, or null when none. */
export function primaryApprover(deps: TelegramBotDeps): string | null {
	return deps.approvers[0] ?? null;
}

/** What an admin callback produced. */
export type TelegramCallbackResult =
	| { kind: 'granted'; subscriptionId: string; plan: string }
	| { kind: 'follow_up'; reason: string }
	| { kind: 'unknown'; reason: string };

// ---------------------------------------------------------------------------
// render helpers — pure text built on core facts only.
// ---------------------------------------------------------------------------

/** The marketplace listing, byte-identical to Discord's (owner rule 17). */
export function plansText(): string {
	return plansMessage();
}

/** The safe "unknown plan" reply, byte-identical across both channels. */
export function unknownPlanText(_planId: string): string {
	return unknownPlanMessage();
}

/** What a member reads after their payment is confirmed and their key published. */
export function grantedText(planId: string): string {
	const plan = planOf(planId);
	if (!plan) return 'Your payment has been confirmed. Your API key has been published.';
	return (
		`Confirmed — your ${plan.label} plan (${formatIdr(plan.priceIdr)}) is now active ` +
		`and your API key has been published.`
	);
}

/** A generic payment-start failure. */
export function paymentErrorText(reason: string): string {
	return `Could not start the payment (${reason}). Please try again.`;
}

// ---------------------------------------------------------------------------
// handlers — translate an update into core calls + rendered replies.
// ---------------------------------------------------------------------------

/**
 * Route one member message. A `/`-prefixed first token is a command; a photo
 * with no command text is a proof upload; anything else is ignored.
 */
export async function handleMessage(deps: TelegramBotDeps, msg: TelegramMessage): Promise<void> {
	const text = (msg.text ?? '').trim();
	if (msg.photo && !text) {
		await handleProof(deps, msg);
		return;
	}
	if (text.startsWith('/')) {
		await handleCommand(deps, msg, text);
	}
}

async function handleCommand(deps: TelegramBotDeps, msg: TelegramMessage, text: string): Promise<void> {
	const { command, arg } = parseCommand(text);
	switch (command) {
		case 'start':
		case 'plans':
			await deps.send(msg.chatId, plansText());
			return;
		case 'pay':
			await handlePay(deps, msg, arg);
			return;
		default:
			// An unknown command still gets the one surface a member needs.
			await deps.send(msg.chatId, plansText());
	}
}

async function handlePay(deps: TelegramBotDeps, msg: TelegramMessage, planId: string): Promise<void> {
	// The price/QR decision is paymentPrompt's (core). A typo'd plan answers
	// "unknown plan" instead of rendering a broken QR.
	const prompt = paymentPrompt(planId);
	if (!prompt) {
		await deps.send(msg.chatId, unknownPlanText(planId));
		return;
	}

	const accountId = await deps.accountIdFor(msg.chatId);
	if (!accountId) {
		await deps.send(msg.chatId, 'Link your Telegram account in the dashboard before paying.');
		return;
	}

	// Mint the pending payment through B1's existing createPayment — never a
	// hand-rolled insert. The amount is the prompt's, not a local copy.
	const mint = await createPayment(
		{ store: deps.gatewayStore },
		{
			accountId,
			channel: 'telegram',
			plan: planId,
			amountIdr: prompt.amountIdr,
			idempotencyKey: `tg:${accountId}:${msg.updateId}`
		}
	);
	if (!mint.ok) {
		await deps.send(msg.chatId, paymentErrorText(mint.reason));
		return;
	}

	await deps.send(msg.chatId, prompt.text, { qris: prompt.qris });
}

/**
 * Render the approval prompt that goes to ONE approver chat, from core facts
 * only. This stays here (not duplicated in the transport) so the initial prompt
 * and every B5 escalation use the exact same text, buttons and claim. The
 * transport's escalation loop is:
 *
 *   const next = escalate(state, approvers, Date.now(), ttlMs);
 *   if (next) await deps.send(approvers[next.promptedIndex], ...approvalMessage(...));
 */
export function approvalMessage(
	approverChatId: string,
	member: string,
	planId: string,
	proofUrl: string,
	claim: TelegramClaim
): { chatId: string; text: string; opts: TelegramSendOptions } {
	const prompt = adminApprovalPrompt(member, planId, proofUrl);
	return { chatId: approverChatId, text: prompt.text, opts: { buttons: prompt.buttons, claim } };
}

async function handleProof(deps: TelegramBotDeps, msg: TelegramMessage): Promise<void> {
	const accountId = await deps.accountIdFor(msg.chatId);
	if (!accountId) {
		await deps.send(msg.chatId, 'Link your Telegram account in the dashboard before paying.');
		return;
	}

	const pending = await deps.findPendingPayment(accountId);
	if (!pending) {
		await deps.send(msg.chatId, 'No pending payment found. Run /pay <plan> first.');
		return;
	}

	const proofUrl = msg.photo?.url ?? msg.photo?.fileId ?? '';
	const recorded = await deps.recordClaim({ paymentId: pending.paymentId, proofUrl });
	if (!recorded.ok) {
		await deps.send(msg.chatId, 'Could not record your proof. Please try again.');
		return;
	}

	const name = msg.username ?? 'a member';
	const claim: TelegramClaim = {
		paymentId: pending.paymentId,
		memberChatId: msg.chatId,
		memberName: name
	};

	// B5: prompt the PRIMARY approver. No approver configured -> fail closed
	// (the proof is recorded, but nothing routes a yes/no to nowhere).
	const approver = primaryApprover(deps);
	if (!approver) {
		await deps.send(msg.chatId, 'Proof received. No approver is configured to confirm it yet.');
		return;
	}
	const routed = approvalMessage(approver, name, pending.planId, proofUrl, claim);
	await deps.send(routed.chatId, routed.text, routed.opts);
}

/**
 * Handle the admin's Yes/No answer (owner rule 21). The decision is
 * bots.ts `decideClaim`'s and only its own; the durable grant is
 * payment-confirm.ts `confirmAndGrant`'s and only its own.
 */
export async function handleCallbackQuery(
	deps: TelegramBotDeps,
	query: TelegramCallbackQuery
): Promise<TelegramCallbackResult> {
	const record = await deps.resolveClaim(query.claim.paymentId);
	if (!record) {
		await deps.answerCallback(query.id, 'Claim not found');
		return { kind: 'unknown', reason: 'claim_not_found' };
	}

	const now = deps.now?.() ?? new Date();

	// `status` is a display fact only: decideClaim re-derives the confirmed state
	// for resolveGrant. A "yes" still cannot grant a short/unknown payment.
	const decision = decideClaim(
		{ plan: record.plan, status: 'claimed', amountIdr: record.amountIdr },
		query.answer,
		now
	);

	if (!decision.grant) {
		await deps.send(query.claim.memberChatId, followUpMessage(record.plan));
		await deps.answerCallback(
			query.id,
			decision.reason === 'admin_declined' ? 'No — following up' : `Not granted (${decision.reason})`
		);
		return { kind: 'follow_up', reason: decision.reason };
	}

	const result = await confirmAndGrant(
		{ store: deps.paymentConfirmStore, now },
		record,
		deps.subscriptionWriter
	);

	if (!result.ok) {
		// The money rule refused after a "yes" (short amount / unknown plan). The
		// member is told to complete payment; nothing is granted.
		await deps.send(query.claim.memberChatId, followUpMessage(record.plan));
		await deps.answerCallback(query.id, `Refused: ${result.reason}`);
		return { kind: 'follow_up', reason: result.reason };
	}

	await deps.send(query.claim.memberChatId, grantedText(result.grant.plan));
	await deps.answerCallback(query.id, 'Granted — key published');
	return { kind: 'granted', subscriptionId: result.grant.subscriptionId, plan: result.grant.plan };
}

/**
 * Deliver an auto-warn to a member's chat (owner rule 16). The text is
 * bots.ts `warningText`'s; this is only the Telegram delivery.
 */
export async function deliverWarning(
	deps: TelegramBotDeps,
	chatId: string,
	kind: string,
	detail = ''
): Promise<void> {
	await deps.send(chatId, warningText(kind, detail));
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Split `/pay sub_7d` into `{ command: 'pay', arg: 'sub_7d' }`. */
function parseCommand(text: string): { command: string | null; arg: string } {
	const m = /^\/([A-Za-z0-9_]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!m) return { command: null, arg: '' };
	return { command: m[1].toLowerCase(), arg: (m[2] ?? '').trim() };
}