/**
 * SQL aggregates behind the abuse dashboard (PRD §70–71).
 *
 * Everything here is plain SQL over `request_log` / `audit_log` / `budget`:
 * threshold rules need counts per window and nothing else. No intent
 * classification anywhere in the security slice — the whole trick is
 * `evaluateSecuritySignals` comparing a count to a threshold.
 *
 * The query functions take a db handle (the singleton or a transaction) so the
 * window merge stays pure and testable without a database.
 */
import { sql } from 'drizzle-orm';
import type { DbTx } from '$lib/server/audit';
import type { WindowStats } from '$lib/server/admin-signals';

/**
 * `audit_log` actions counted as key-lifecycle churn (rotations + creations).
 * The spec set is `key.rotate`, `api_key.rotate`, `key.create`; the console
 * writes `key.create` / `key.rotate` today, so the dashboard says which of the
 * set it actually matched rather than silently narrowing.
 */
export const KEY_LIFECYCLE_ACTIONS = ['key.rotate', 'api_key.rotate', 'key.create'] as const;

/** The abuse dashboard aggregates platform-wide over this trailing window. */
export const WINDOW_HOURS = 24;

interface RequestWindowRow {
	windowStart: Date;
	requests: number;
	authFailures: number;
	errorCount: number;
	credentialAuthFailures: number;
	distinctIps: number;
	topIpCount: number;
	spendMicro: string | number;
}

interface RawRequestWindowRow {
	window_start: Date;
	requests: number;
	auth_failures: number;
	error_count: number;
	credential_auth_failures: number;
	distinct_ips: number;
	top_ip_count: number;
	spend_micro: string | number;
}

interface RotationWindowRow {
	windowStart: Date;
	n: number;
}

interface RawRotationWindowRow {
	window_start: Date;
	n: number;
}

/**
 * Per-hour request stats for the trailing window.
 *
 * - `auth_failures` = `error_code = 'AUTHENTICATION_ERROR'`
 * - `error_count` = non-success rows
 * - `credential_auth_failures` = the credential-abuse proxy: rows whose
 *   `http_status` is 401/403 (an upstream rejecting the credential)
 * - `distinct_ips` = `count(distinct client_ip)` (NULL addresses excluded)
 * - `top_ip_count` = the busiest single address's share numerator
 */
export async function requestWindowRows(
	dbx: DbTx,
	hours = WINDOW_HOURS
): Promise<RequestWindowRow[]> {
	const rows = (await dbx.execute(sql`
		WITH base AS (
			SELECT
				date_trunc('hour', created_at) AS window_start,
				client_ip,
				cost,
				(error_code = 'AUTHENTICATION_ERROR') AS is_auth_fail,
				(status <> 'success') AS is_err,
				(http_status IN (401, 403)) AS is_cred_fail
			FROM request_log
			WHERE created_at >= now() - interval '1 hour' * ${hours}
		),
		per_ip AS (
			SELECT window_start, client_ip, count(*)::int AS n
			FROM base
			WHERE client_ip IS NOT NULL
			GROUP BY 1, 2
		),
		ip_stats AS (
			SELECT window_start, count(*)::int AS distinct_ips, max(n)::int AS top_ip_count
			FROM per_ip
			GROUP BY 1
		),
		agg AS (
			SELECT
				window_start,
				count(*)::int AS requests,
				(count(*) FILTER (WHERE is_auth_fail))::int AS auth_failures,
				(count(*) FILTER (WHERE is_err))::int AS error_count,
				(count(*) FILTER (WHERE is_cred_fail))::int AS credential_auth_failures,
				coalesce(sum(cost), 0) AS spend_micro
			FROM base
			GROUP BY 1
		)
		SELECT
			a.window_start, a.requests, a.auth_failures, a.error_count,
			a.credential_auth_failures, a.spend_micro,
			coalesce(i.distinct_ips, 0) AS distinct_ips,
			coalesce(i.top_ip_count, 0) AS top_ip_count
		FROM agg a
		LEFT JOIN ip_stats i ON i.window_start = a.window_start
		ORDER BY a.window_start DESC
	`)) as unknown as RawRequestWindowRow[];
	return rows.map((r) => ({
		windowStart: r.window_start,
		requests: r.requests,
		authFailures: r.auth_failures,
		errorCount: r.error_count,
		credentialAuthFailures: r.credential_auth_failures,
		distinctIps: r.distinct_ips,
		topIpCount: r.top_ip_count,
		spendMicro: r.spend_micro
	}));
}

/** Per-hour `audit_log` key-lifecycle action counts for the trailing window. */
export async function keyRotationWindowRows(
	dbx: DbTx,
	hours = WINDOW_HOURS
): Promise<RotationWindowRow[]> {
	const actions = KEY_LIFECYCLE_ACTIONS.map((a) => sql`${a}`);
	const rows = (await dbx.execute(sql`
		SELECT date_trunc('hour', created_at) AS window_start, count(*)::int AS n
		FROM audit_log
		WHERE created_at >= now() - interval '1 hour' * ${hours}
			AND action IN (${sql.join(actions)})
		GROUP BY 1
		ORDER BY 1 DESC
	`)) as unknown as RawRotationWindowRow[];
	return rows.map((r) => ({ windowStart: r.window_start, n: r.n }));
}

/** Which of `KEY_LIFECYCLE_ACTIONS` actually occur in the trailing window. */
export async function matchedKeyLifecycleActions(dbx: DbTx, hours = WINDOW_HOURS): Promise<string[]> {
	const actions = KEY_LIFECYCLE_ACTIONS.map((a) => sql`${a}`);
	const rows = (await dbx.execute(sql`
		SELECT DISTINCT action
		FROM audit_log
		WHERE created_at >= now() - interval '1 hour' * ${hours}
			AND action IN (${sql.join(actions)})
		ORDER BY action
	`)) as unknown as { action: string }[];
	return rows.map((r) => r.action);
}

/**
 * The budget in force for the aggregated (platform) scope: the sum of every
 * `budget` row, or null when no budget exists at all — `budgetMicro: null` is
 * legal and simply rules out `budget_anomaly` signals.
 */
export async function platformBudgetMicro(dbx: DbTx): Promise<bigint | null> {
	const rows = (await dbx.execute(sql`
		SELECT count(*)::int AS n, coalesce(sum(amount_micro), 0) AS total FROM budget
	`)) as unknown as { n: number; total: string | number }[];
	const row = rows[0];
	if (!row || row.n === 0) return null;
	return BigInt(String(row.total));
}

/**
 * Fold request stats and key-rotation counts into `WindowStats` rows, one per
 * hour bucket. Rotation-only hours (a key storm with zero traffic) are kept:
 * the `key_rotation` rule must be able to fire on them.
 */
export function mergeWindows(
	requests: readonly RequestWindowRow[],
	rotations: readonly RotationWindowRow[],
	budgetMicro: bigint | null
): WindowStats[] {
	const byStart: Record<number, WindowStats> = {};
	const ensure = (windowStart: Date): WindowStats => {
		const key = windowStart.getTime();
		let w = byStart[key];
		if (!w) {
			w = {
				windowStart,
				requests: 0,
				authFailures: 0,
				errorCount: 0,
				distinctIps: 0,
				topIpShare: 0,
				keyRotations: 0,
				credentialAuthFailures: 0,
				spendMicro: 0n,
				budgetMicro
			};
			byStart[key] = w;
		}
		return w;
	};
	for (const r of requests) {
		const w = ensure(r.windowStart);
		w.requests = r.requests;
		w.authFailures = r.authFailures;
		w.errorCount = r.errorCount;
		w.credentialAuthFailures = r.credentialAuthFailures;
		w.distinctIps = r.distinctIps;
		w.topIpShare = r.requests > 0 ? r.topIpCount / r.requests : 0;
		w.spendMicro = BigInt(String(r.spendMicro ?? 0));
	}
	for (const r of rotations) ensure(r.windowStart).keyRotations = r.n;
	return Object.values(byStart).sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime());
}

/** Gather every window the rules are evaluated against, newest first. */
export async function buildWindowStats(dbx: DbTx, hours = WINDOW_HOURS): Promise<WindowStats[]> {
	const [requests, rotations, budgetMicro] = await Promise.all([
		requestWindowRows(dbx, hours),
		keyRotationWindowRows(dbx, hours),
		platformBudgetMicro(dbx)
	]);
	return mergeWindows(requests, rotations, budgetMicro);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = new RegExp(
	'^(?:' +
		'(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|' +
		'(?:[0-9a-f]{1,4}:){1,7}:|' +
		'(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|' +
		'(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|' +
		'(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|' +
		'(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|' +
		'(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|' +
		'[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|' +
		':(?:(?::[0-9a-f]{1,4}){1,7}|:)' +
		')$',
	'i'
);

/**
 * Strict IP / CIDR validation for the blocked-address list. Accepts a bare
 * IPv4/IPv6 address or one with a prefix length (v4 ≤ /32, v6 ≤ /128).
 * Anything else — hostnames, spaces, half-typed octets — is rejected: this
 * string is what the edge matches traffic against.
 */
export function isIpOrCidr(value: string): boolean {
	const v = value.trim();
	if (!v || v.length > 64) return false;
	const slash = v.indexOf('/');
	if (slash === -1) return IPV4.test(v) || IPV6.test(v);
	if (v.indexOf('/', slash + 1) !== -1) return false;
	const addr = v.slice(0, slash);
	const prefix = v.slice(slash + 1);
	if (!/^(0|[1-9]\d?)$/.test(prefix)) return false;
	const max = IPV4.test(addr) ? 32 : IPV6.test(addr) ? 128 : -1;
	return max > 0 && Number(prefix) <= max;
}
