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
//                              (one admin is a SPOF — S9/P1.3)
//   FUDROUTER_APPROVAL_TTL_MS  silence window in milliseconds before the
//                              prompt escalates; default 15 minutes.

import { parseApprovers, parseApprovalTtlMs } from './approval.ts';

/** env var: comma-separated approver ids, primary first. */
export const APPROVERS_ENV = 'FUDROUTER_APPROVERS';

/** env var: escalation silence window in milliseconds. */
export const APPROVAL_TTL_ENV = 'FUDROUTER_APPROVAL_TTL_MS';

/** The approver list from the environment; `[]` when unset (fail closed). */
export function approvers(): string[] {
	return parseApprovers(process.env[APPROVERS_ENV]);
}

/** The escalation TTL from the environment (default when unset/malformed). */
export function approvalTtlMs(): number {
	return parseApprovalTtlMs(process.env[APPROVAL_TTL_ENV]);
}

/** Both values a transport needs to wire one approval queue. */
export function approvalConfig(): { approvers: string[]; ttlMs: number } {
	return { approvers: approvers(), ttlMs: approvalTtlMs() };
}