// packages/platform/server/approval-loop.ts — the durable escalation tick (B5b).
//
// B5 (approval.ts) owns the escalation RULES: `approvalRoute` decides where a
// claim should sit and `escalate` turns that into the one state transition a
// transport must persist. What was missing is the TICK that drives those rules
// against the payment table: without it, a claimed payment whose primary stays
// silent past the TTL is never re-prompted — a single admin is a SPOF (owner
// directive docs/plans/fr-approve.md S9 / P1.3).
//
// This module is the runtime half of B5b:
//
//   - `tickApproval` is PURE: given a persisted/absent ApprovalClaim, the clock
//     and the TTL, it returns one `EscalationStep` — either bootstrap/prompt the
//     next approver or do nothing. The decision is delegated to
//     approval.ts `escalate` (which projects `approvalRoute`); this file adds NO
//     duplicate escalation logic, only the per-tick frame around it.
//
//   - `createEscalationLoop` is the DURABLE driver: a `setInterval` that scans
//     open claims (status='claimed', not yet confirmed), reconstructs each
//     ApprovalClaim from `payment.raw.approval` (bootstrap from `updated_at`
//     when absent), feeds it to `tickApproval` and PERSISTS the resulting claim
//     back into `raw.approval` whenever it prompts. It is idempotent (the
//     write is a merge, never a clobber of `raw.proofUrl`), fail-soft (one bad
//     payment never crashes the tick or the timer) and stoppable (`stop()`).
//
// Core ≠ transport: the loop knows Postgres through the injected `getDb()`
// (same `DbTx` shape as payment-confirm.ts / claim.ts) and talks to the world
// only through the injected `prompt(approverIdx, payment)` seam — so tests run
// against an in-memory stand-in with no network, no secret and no DATABASE_URL.
// The console (apps/web/server/index.mjs) wires `getDb()` to its drizzle handle,
// `approvers`/`ttlMs` to approval-env.ts and `prompt` to whichever transport is
// live (Telegram and/or Discord), using the adminApprovalPrompt core render.

import { asc, eq } from 'drizzle-orm';

import { escalate, type ApprovalClaim } from './approval.ts';
import { payment } from './db/schema.ts';
import type { DbTx } from './audit.ts';

// ---------------------------------------------------------------------------
// pure tick
// ---------------------------------------------------------------------------

/** One timer-tick decision for a single open payment. */
export interface EscalationStep {
	/**
	 * The claim to PERSIST when `action === 'prompt'` (the next holder), or the
	 * current claim when bootstrapping. `null` only when there is nothing to
	 * write (answered, no approvers, or already at the last fallback).
	 */
	claim: ApprovalClaim | null;
	/** `prompt` -> send the admin prompt to `approvers[toIndex]`; `nop` -> hold. */
	action: 'prompt' | 'nop';
	/** The approver index to prompt (only meaningful when `action === 'prompt'`). */
	toIndex: number;
}

export interface PaymentForPrompt {
	id: string;
	/** The channel the claim came from (`telegram` | `discord` | `web`). */
	channel: string;
	/** The platform account that owns the payment (for member-chat lookup). */
	accountId: string;
	planId: string;
	memberName: string;
	proofUrl: string;
}

export type PromptFn = (approverIdx: number, payment: PaymentForPrompt) => Promise<void>;

/** Reconstruct a persisted claim from `payment.raw` already fetched by the scan. */
export function approvalClaimFromRaw(
	raw: Record<string, unknown> | null | undefined
): ApprovalClaim | null {
	const a = raw?.approval as ApprovalClaim | undefined;
	if (a && typeof a.promptedIndex === 'number' && typeof a.promptedAt === 'number') {
		return a;
	}
	return null;
}

/**
 * Merge an escalation claim into `payment.raw` without clobbering the other keys
 * the claim writer already stored (`proofUrl`, member name, …). Idempotent: the
 * same claim written twice yields the same `approval` key.
 */
export function mergeApprovalInto(
	raw: Record<string, unknown> | null | undefined,
	claim: ApprovalClaim
): Record<string, unknown> {
	return { ...(raw ?? {}), approval: claim };
}

/** The claim write the loop performs when a tick decides to prompt. */
export interface ClaimPersistence {
	save(paymentId: string, claim: ApprovalClaim): Promise<void>;
}

/**
 * One pure escalation decision for a claim's current state (B5b contract):
 *
 *   - no claim yet   -> bootstrap: prompt the PRIMARY (approvers[0]);
 *   - claim present  -> delegate to approval.ts `escalate`:
 *                        - TTL elapsed & a next approver exists -> prompt it;
 *                        - answered, still within TTL, or already at the last
 *                          fallback -> hold (`nop`), never re-prompt/wrap.
 *
 * This is the ONLY decision site the loop calls; the escalation arithmetic lives
 * in approval.ts, not here (acceptance: no duplicated escalate/approvalRoute).
 */
export function tickApproval(
	state: ApprovalClaim | null,
	approvers: readonly string[],
	now: number,
	ttlMs: number
): EscalationStep {
	if (approvers.length === 0) {
		// Fail closed: with nobody to prompt there is nothing to persist.
		return { claim: null, action: 'nop', toIndex: -1 };
	}
	if (state === null) {
		const boot: ApprovalClaim = {
			promptedIndex: 0,
			promptedAt: now,
			answeredBy: null,
			answeredAt: null
		};
		// Bootstrap is also a prompt: the primary must be asked the first time.
		return { claim: boot, action: 'prompt', toIndex: 0 };
	}
	const next = escalate(state, approvers, now, ttlMs);
	if (next === null) {
		// Answered, inside the TTL, or nobody further to hand off to: hold.
		return { claim: null, action: 'nop', toIndex: state.promptedIndex };
	}
	return { claim: next, action: 'prompt', toIndex: next.promptedIndex };
}

// ---------------------------------------------------------------------------
// durable loop
// ---------------------------------------------------------------------------

export interface EscalationLoopDeps {
	/** The drizzle handle (console's `getDb`). */
	getDb(): DbTx | null;
	/** Ordered approver ids; the loop only runs when length >= 2. */
	approvers: string[];
	/** Silence window before the prompt escalates (approval-env's ttl). */
	ttlMs: number;
	/** Frozen clock for the tick (tests); defaults to `Date.now`. */
	now?: () => number;
	/** Transport send: render + deliver the admin prompt to approver `idx`. */
	prompt: PromptFn;
	/** Tick interval (default 60s). */
	tickMs?: number;
	/** Claim persistence seams; default to the DB-backed writer below. */
	persistence?: ClaimPersistence;
	/** Failure log (tests); defaults to console.warn. */
	log?: Pick<Console, 'warn' | 'error'>;
}

export interface EscalationLoop {
	/** Stop the timer; no further ticks fire. Idempotent. */
	stop(): void;
	/** Number of ticks run so far (diagnostics/tests). */
	tickCount(): number;
}

/**
 * A slice of payment rows the loop needs to prompt one approver, resolved from
 * the trusted store. `proofUrl` and the member display name feed the
 * adminApprovalPrompt render (bots.ts) — the exact text both transports send.
 */
export interface OpenClaimRow {
	id: string;
	accountId: string;
	channel: string;
	plan: string;
	status: string;
	raw: Record<string, unknown> | null;
	updatedAt: Date;
	memberName: string;
	proofUrl: string;
}

/** Default claim persist: write `payment.raw.approval` via drizzle `DbTx`. */
export function drizzleClaimPersistence(db: DbTx | null): ClaimPersistence {
	if (!db) {
		return {
			save: async () => undefined
		};
	}
	return {
		async save(paymentId, claim): Promise<void> {
			const rows = await db
				.select({ raw: payment.raw })
				.from(payment)
				.where(eq(payment.id, paymentId))
				.limit(1);
			const raw = (rows[0]?.raw as Record<string, unknown> | undefined) ?? {};
			await db
				.update(payment)
				.set({ raw: mergeApprovalInto(raw, claim), updatedAt: new Date() })
				.where(eq(payment.id, paymentId));
		}
	};
}

/**
 * The claim scan: every `payment` still open for approval (status='claimed' and
 * not yet 'confirmed'/'rejected'). `raw->approval` may be present (a prior
 * tick) or absent (a fresh claim) — both are fed to `tickApproval`, which
 * bootstraps the latter. Returns at most `limit` rows per tick, ordered oldest
 * claim first (`updated_at`, then `id`) so the slice is deterministic: the
 * most overdue prompt is handled first and a claim beyond the slice is not
 * starved by heap order.
 */
export async function listOpenPayments(db: DbTx | null, limit = 200): Promise<OpenClaimRow[]> {
	if (!db) return [];
	const rows = await db
		.select({
			id: payment.id,
			accountId: payment.accountId,
			channel: payment.channel,
			plan: payment.plan,
			status: payment.status,
			raw: payment.raw,
			updatedAt: payment.updatedAt
		})
		.from(payment)
		.where(eq(payment.status, 'claimed'))
		// Oldest claim first, so a tick always handles the most overdue prompt.
		// Without a deterministic order the LIMIT slice depends on heap order
		// and a claim past the first `limit` rows starves: it is never
		// bootstrapped, so its primary is never prompted at all. (id as the
		// tiebreak so two rows sharing a timestamp swap between ticks.)
		.orderBy(asc(payment.updatedAt), asc(payment.id))
		.limit(limit);
	return rows.map((r) => {
		const raw = (r.raw as Record<string, unknown> | undefined) ?? {};
		return {
			id: r.id,
			accountId: r.accountId,
			channel: r.channel,
			plan: r.plan,
			status: r.status,
			raw,
			updatedAt: r.updatedAt,
			memberName: typeof raw.memberName === 'string' ? raw.memberName : 'a member',
			proofUrl: typeof raw.proofUrl === 'string' ? raw.proofUrl : ''
		};
	});
}

/**
 * Create the durable escalation loop. Only meaningful when at least TWO
 * approvers are configured (a single approver cannot escalate — SPOF), which
 * the CALLER checks via `approvers.length >= 2`; this function also refuses to
 * start a timer for < 2 approvers (fail closed, returns a no-op loop).
 *
 * Each tick:
 *  1. scan open ('claimed') payments;
 *  2. reconstruct each claim from `raw.approval` (bootstrap when absent);
 *  3. `tickApproval` -> prompt the next approver and PERSIST its claim when the
 *     step says `prompt`;
 *  4. fail-soft: a DB error or a send failure on one row is logged and the tick
 *     continues; it never crashes the timer.
 */
export function createEscalationLoop(deps: EscalationLoopDeps): EscalationLoop {
	const {
		getDb,
		approvers,
		ttlMs,
		now = () => Date.now(),
		prompt,
		tickMs = 60_000,
		log = console
	} = deps;
	const persistence = deps.persistence ?? drizzleClaimPersistence(getDb());

	let timer: NodeJS.Timeout | null = null;
	let count = 0;

	// A single approver cannot escalate (one admin is the SPOF the loop exists
	// to remove): refuse to start a timer and log, fail closed. The console
	// checks this before calling, but the loop must not start even if wired
	// with a short list.
	if (approvers.length < 2) {
		log.warn?.('[approval-loop] not started: need at least 2 approvers, got', approvers.length);
		return {
			stop() {
				if (timer !== null) clearInterval(timer);
				timer = null;
			},
			tickCount() {
				return 0;
			}
		};
	}

	async function tick(): Promise<void> {
		if (approvers.length < 2) return; // never prompt when escalation is moot
		const db = getDb();
		const rows = await listOpenPayments(db);
		for (const row of rows) {
			try {
				// Reconstruct the claim from the raw the scan already fetched: a prior
				// tick persisted `raw.approval`; a fresh claim has none, so bootstrap from
				// `updated_at` (the claim moment) — the TTL window is measured from
				// payment time, not from when this loop first noticed the row.
				const claim: ApprovalClaim =
					approvalClaimFromRaw(row.raw) ??
					{
						promptedIndex: 0,
						promptedAt: row.updatedAt.getTime(),
						answeredBy: null,
						answeredAt: null
					};
				const step = tickApproval(claim, approvers, now(), ttlMs);
				if (step.action !== 'prompt' || !step.claim) continue;
				await prompt(step.toIndex, {
					id: row.id,
					channel: row.channel,
					accountId: row.accountId,
					planId: row.plan,
					memberName: row.memberName,
					proofUrl: row.proofUrl
				});
				await persistence.save(row.id, step.claim);
			} catch (err) {
				log.warn('[approval-loop] tick failed for', row.id, err instanceof Error ? err.message : err);
			}
		}
	}

	async function runTick(): Promise<void> {
		count += 1;
		try {
			await tick();
		} catch (err) {
			log.error?.('[approval-loop] tick failed', err instanceof Error ? err.message : err);
		}
	}

	timer = setInterval(() => {
		void runTick();
	}, tickMs);
	// Do not hold the process open just for this timer (a test or a one-shot
	// script must still exit); the console's own HTTP listener keeps it alive.
	timer.unref?.();

	return {
		stop() {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		tickCount() {
			return count;
		}
	};
}
