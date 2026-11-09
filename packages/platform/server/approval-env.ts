// packages/platform/server/approval-env.ts — environment reads for B5.
//
// The escalation rules are pure and live in approval.ts; this module is the
// only place that touches process.env for them — the same publish.ts /
// publish-env.ts split — which is what keeps `approvalRoute` / `nextApprover`
// unit-testable without a network.
//
// Variables (documented here because the transport reads them through this
// module, not because the pure core ever does):
//
//   FUDROUTER_APPROVERS        comma-separated approver ids, primary first
//                              (one admin is a SPOF — S9/P1.3). These are the
//                              PROMPT DESTINATIONS (Telegram chat_id / Discord
//                              channel_id), not the human's identity.
//   FUDROUTER_TELEGRAM_APPROVER_USERS
//                              comma-separated Telegram USER ids allowed to
//                              press the approve button. Empty => deny all
//                              (fail-closed). Separate from APPROVERS so the
//                              routing list and the actor allow-list never
//                              conflate "where the prompt goes" with "who may
//                              answer".
//   FUDROUTER_DISCORD_APPROVER_USERS
//                              comma-separated Discord USER ids allowed to
//                              press the approve button. Empty => deny all.
//   FUDROUTER_APPROVAL_TTL_MS  silence window in milliseconds before the
//                              prompt escalates; default 15 minutes.

import { parseApprovers, parseApprovalTtlMs, parseApproverUsers } from './approval.ts';

/** env var: comma-separated approver ids, primary first. */
export const APPROVERS_ENV = 'FUDROUTER_APPROVERS';

/** env var: escalation silence window in milliseconds. */
export const APPROVAL_TTL_ENV = 'FUDROUTER_APPROVAL_TTL_MS';

/** env var: Telegram user ids allowed to approve. Empty => deny all (C2). */
export const TELEGRAM_APPROVER_USERS_ENV = 'FUDROUTER_TELEGRAM_APPROVER_USERS';

/** env var: Discord user ids allowed to approve. Empty => deny all (C2). */
export const DISCORD_APPROVER_USERS_ENV = 'FUDROUTER_DISCORD_APPROVER_USERS';

/** The approver list from the environment; `[]` when unset (fail closed). */
export function approvers(): string[] {
	return parseApprovers(process.env[APPROVERS_ENV]);
}

/** The escalation TTL from the environment (default when unset/malformed). */
export function approvalTtlMs(): number {
	return parseApprovalTtlMs(process.env[APPROVAL_TTL_ENV]);
}

/**
 * The Telegram actor allow-list (C2). `[]` when unset — every actor is refused,
 * never allow-all.
 */
export function telegramApproverUsers(): string[] {
	return parseApproverUsers(process.env[TELEGRAM_APPROVER_USERS_ENV]);
}

/**
 * The Discord actor allow-list (C2). `[]` when unset — every actor is refused,
 * never allow-all.
 */
export function discordApproverUsers(): string[] {
	return parseApproverUsers(process.env[DISCORD_APPROVER_USERS_ENV]);
}

/** Both values a transport needs to wire one approval queue. */
export function approvalConfig(): {
	approvers: string[];
	ttlMs: number;
	telegramApproverUsers: string[];
	discordApproverUsers: string[];
} {
	return {
		approvers: approvers(),
		ttlMs: approvalTtlMs(),
		telegramApproverUsers: telegramApproverUsers(),
		discordApproverUsers: discordApproverUsers()
	};
}