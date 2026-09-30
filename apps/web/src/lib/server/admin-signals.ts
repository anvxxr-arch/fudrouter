/**
 * Rule-based security signals (PRD §70) — plain threshold rules over SQL
 * aggregates from `request_log` / `audit_log`. NO ML, no model call, no
 * inference of intent: every fired signal names the rule, the window and the
 * exact count that tripped it.
 *
 * The page gathers `WindowStats` rows in SQL (one query per window bucket);
 * this module decides what they mean. Pure so the rule table is testable
 * without a database.
 */
export const SIGNAL_KINDS = [
	'request_spike',
	'auth_failures',
	'key_rotation',
	'ip_distribution',
	'budget_anomaly',
	'excessive_errors',
	'credential_abuse'
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type SecurityAction = 'log' | 'block';

export interface SecurityRuleRow {
	id: string;
	name: string;
	kind: SignalKind;
	/** `{"threshold": n, "window_seconds": n}`; `budget_anomaly` threshold is a percent. */
	config: Record<string, unknown>;
	enabled: boolean;
	action: SecurityAction;
}

/** Aggregates for one window bucket (already scoped by the SQL that built it). */
export interface WindowStats {
	windowStart: Date;
	requests: number;
	/** `error_code = 'AUTHENTICATION_ERROR'` count. */
	authFailures: number;
	/** Non-success request count. */
	errorCount: number;
	distinctIps: number;
	/** Share (0..1) of requests coming from the single busiest address. */
	topIpShare: number;
	/** `audit_log` key-rotate actions in the window. */
	keyRotations: number;
	/** Attempts that failed upstream auth (401/403 at a provider). */
	credentialAuthFailures: number;
	spendMicro: bigint;
	/** The budget in force for the scope, when one exists. */
	budgetMicro: bigint | null;
}

export interface Signal {
	ruleId: string;
	name: string;
	kind: SignalKind;
	action: SecurityAction;
	at: Date;
	/** The observed value that tripped the rule. */
	value: number;
	threshold: number;
	windowSeconds: number;
	message: string;
}

function thresholdOf(config: Record<string, unknown>): number {
	const t = Number(config.threshold);
	return Number.isFinite(t) ? t : 0;
}
function windowOf(config: Record<string, unknown>): number {
	const w = Number(config.window_seconds);
	return Number.isFinite(w) && w > 0 ? w : 3600;
}

/** Did this rule trip on this window, and with what observed value? */
function trip(rule: SecurityRuleRow, s: WindowStats): { value: number; message: string } | null {
	const threshold = thresholdOf(rule.config);
	switch (rule.kind) {
		case 'request_spike':
			return s.requests >= threshold && threshold > 0
				? { value: s.requests, message: `${s.requests} requests in the window (threshold ${threshold})` }
				: null;
		case 'auth_failures':
			return s.authFailures >= threshold && threshold > 0
				? { value: s.authFailures, message: `${s.authFailures} authentication failures (threshold ${threshold})` }
				: null;
		case 'key_rotation':
			return s.keyRotations >= threshold && threshold > 0
				? { value: s.keyRotations, message: `${s.keyRotations} API key rotations (threshold ${threshold})` }
				: null;
		case 'ip_distribution':
			return s.distinctIps >= threshold && threshold > 0
				? {
						value: s.distinctIps,
						message: `${s.distinctIps} distinct client addresses, busiest carries ${(s.topIpShare * 100).toFixed(0)}% (threshold ${threshold} addresses)`
					}
				: null;
		case 'budget_anomaly': {
			// Threshold is a percent of the budget burned inside the window.
			if (s.budgetMicro === null || s.budgetMicro <= 0n || !(threshold > 0)) return null;
			const percent = Number((s.spendMicro * 100n) / s.budgetMicro);
			return percent >= threshold
				? { value: percent, message: `${percent}% of the window budget spent (threshold ${threshold}%)` }
				: null;
		}
		case 'excessive_errors':
			return s.errorCount >= threshold && threshold > 0
				? { value: s.errorCount, message: `${s.errorCount} failed requests (threshold ${threshold})` }
				: null;
		case 'credential_abuse':
			return s.credentialAuthFailures >= threshold && threshold > 0
				? {
						value: s.credentialAuthFailures,
						message: `${s.credentialAuthFailures} upstream credential rejections (threshold ${threshold})`
					}
				: null;
		default:
			return null;
	}
}

/** Evaluate every enabled rule against every window; newest window first. */
export function evaluateSecuritySignals(
	rules: readonly SecurityRuleRow[],
	windows: readonly WindowStats[]
): Signal[] {
	const signals: Signal[] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		for (const s of windows) {
			const hit = trip(rule, s);
			if (hit) {
				signals.push({
					ruleId: rule.id,
					name: rule.name,
					kind: rule.kind,
					action: rule.action,
					at: s.windowStart,
					value: hit.value,
					threshold: thresholdOf(rule.config),
					windowSeconds: windowOf(rule.config),
					message: hit.message
				});
			}
		}
	}
	signals.sort((a, b) => b.at.getTime() - a.at.getTime());
	return signals;
}
