// packages/platform/server/approval.ts — approver fallback/eskalasi (B5).
//
// Owner directive (docs/plans/fr-approve.md S9 / P1.3): one admin is a single
// point of failure. An approval queue must therefore have a SECONDARY approver
// configured via environment (not hardcoded @zupaxx), and the prompt must
// escalate to the next approver when the current one stays silent past a TTL.
// This module holds those DECISIONS as pure functions: no fetch, no DB, no
// process.env, no clock beyond the epoch-millisecond `now` the caller injects.
//
// The adapters (discord-bot.ts, telegram-bot.ts) and their transports own the
// I/O and the environment reads (see approval-env.ts). That is the exact split
// publish.ts / publish-env.ts already uses, so the rule stays unit-testable
// without a network.

/** The silence window after which an unanswered prompt escalates. 15 minutes. */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * One approval prompt's state, persisted by the transport while it is open.
 * The transport keeps this per pending claim and re-evaluates it on every
 * timer tick (or on every relevant update) by feeding it back to
 * `approvalRoute`.
 */
export interface ApprovalClaim {
	/** Index into the approver list the prompt is currently sitting with. */
	promptedIndex: number;
	/** Epoch ms when the current holder was prompted. */
	promptedAt: number;
	/** The approver whose answer settled the claim, or null while open. */
	answeredBy: string | null;
	/** Epoch ms when the answer arrived, or null while open. */
	answeredAt: number | null;
}

/** Clamp a possibly-corrupt stored index into a valid list position. */
function boundedIndex(i: number, length: number): number {
	if (!Number.isFinite(i)) return 0;
	return Math.max(0, Math.min(Math.trunc(i), length - 1));
}

/**
 * The approval routing decision (the transport contract). Given the persisted
 * state of one claim and the ordered approver list, return the index the prompt
 * should be sitting on RIGHT NOW, or null when there is no prompt to make:
 *
 *   - the claim was answered                -> null (settled);
 *   - no approvers are configured           -> null (fail closed);
 *   - the current holder is within the TTL  -> its index (wait, don't move);
 *   - the current holder is past the TTL    -> the NEXT index (escalate);
 *   - the current holder is already last    -> its index (never wrap/repeat).
 *
 * The transport's loop is therefore: `const next = approvalRoute(...); if (next
 * !== null && next !== state.promptedIndex) { promptApprover(approvers[next]);
 * state = { promptedIndex: next, promptedAt: now, ... }; }`.
 */
export function approvalRoute(
	claim: ApprovalClaim,
	approvers: readonly string[],
	now: number,
	ttlMs: number
): number | null {
	if (approvers.length === 0) return null;
	if (claim.answeredBy != null) return null;

	const last = approvers.length - 1;
	const idx = boundedIndex(claim.promptedIndex, approvers.length);
	if (idx >= last) return idx; // nobody further to hand off to: stay put.

	const elapsed = now - claim.promptedAt;
	if (elapsed < ttlMs) return idx; // still inside the silence window.
	return idx + 1; // hand the prompt to the next approver.
}

/**
 * Advance the prompt one escalation step, the single state transition a
 * transport loop needs on each TTL tick:
 *
 *   const next = escalate(state, approvers, Date.now(), ttlMs);
 *   if (next) { prompt(approvers[next.promptedIndex]); state = next; }
 *
 * Returns null (do nothing, don't send) while the current holder is within the
 * TTL, when the claim is already answered, when no approvers are configured, or
 * when the current holder is already the last fallback — no re-prompt, no wrap.
 * The DECISION is exactly `approvalRoute`'s; this only turns it into the state
 * transition a transport has to persist.
 */
export function escalate(
	claim: ApprovalClaim,
	approvers: readonly string[],
	now: number,
	ttlMs: number
): ApprovalClaim | null {
	const index = approvalRoute(claim, approvers, now, ttlMs);
	if (index === null || index === claim.promptedIndex) return null;
	return { promptedIndex: index, promptedAt: now, answeredBy: null, answeredAt: null };
}

/**
 * The primary/secondary escalation decision, the narrow form the mandate names.
 * Returns the next approver to prompt, or null when nothing should be handed
 * off: the primary already answered, or the silence is still within `ttlMs`, or
 * there is no secondary to escalate to. `lastResponderAt` is the epoch ms of the
 * current holder's last prompt/response — the anchor the TTL window starts from.
 */
export function nextApprover(
	approvers: readonly string[],
	answeredBy: string | null | undefined,
	lastResponderAt: number,
	ttlMs: number,
	now: number
): string | null {
	if (approvers.length === 0) return null;
	if (answeredBy != null) return null;
	// A skewed clock must not manufacture an escalation from a bogus delta.
	if (!Number.isFinite(lastResponderAt) || lastResponderAt > now) return null;
	if (now - lastResponderAt < ttlMs) return null;
	return approvers[1] ?? null;
}

/** Approver ids are short channel/chat ids (digits, usernames, @ or - prefix). */
const APPROVER_ID_RE = /^[-@A-Za-z0-9_]{1,64}$/;

/**
 * Parse a comma-separated approver list (`FUDROUTER_APPROVERS`). Order is the
 * escalation order: the first entry is the primary, the second the first
 * fallback, and so on. Empty/whitespace/unset input and empty entries between
 * commas fail closed to `[]`; a non-empty entry that is not a valid approver id
 * throws a clear error rather than routing an approval prompt to a malformed
 * destination. Duplicates are dropped (first occurrence kept).
 */
export function parseApprovers(raw: string | null | undefined): string[] {
	if (raw == null) return [];
	const source = String(raw).trim();
	if (!source) return [];

	const entries = source
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	const invalid = entries.filter((t) => !APPROVER_ID_RE.test(t));
	if (invalid.length > 0) {
		throw new Error(
			`invalid approver id(s): ${invalid.map((t) => JSON.stringify(t)).join(', ')}`
		);
	}
	return [...new Set(entries)];
}

/**
 * Parse the escalation TTL (`FUDROUTER_APPROVAL_TTL_MS`, milliseconds). Unset,
 * blank, or a non-finite/negative value falls back to the 15-minute default, so
 * a malformed value can never disable escalation entirely (or turn it into an
 * instant-per-tick storm).
 */
export function parseApprovalTtlMs(raw: string | null | undefined): number {
	if (raw == null) return DEFAULT_APPROVAL_TTL_MS;
	const s = String(raw).trim();
	if (!s) return DEFAULT_APPROVAL_TTL_MS;
	const n = Number(s);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_APPROVAL_TTL_MS;
	return n;
}