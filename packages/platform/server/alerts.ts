import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db/index.ts';
import {
	alert,
	alertEvent,
	billingAccount,
	budget,
	requestLog,
	systemEvent,
	usageHourly
} from './db/schema.ts';
import { newId } from './id.ts';
import type { JobHandle } from './jobs.ts';
import { dispatchEvent, type WebhookEvent } from './webhooks.ts';

/**
 * Alerting (PRD §42, spec §11).
 *
 * `evaluateAlerts()` runs periodically (the `alert_evaluation` job) and measures
 * each enabled `alert`'s condition over `request_log` / `usage_hourly` — the two
 * sources the PRD names: raw rows for rate/window conditions, the rollup for
 * fallback and availability. Each evaluation lands in exactly one of three
 * states:
 *
 * - BREACH (value crosses `threshold`): when the alert has no firing event yet
 *   a new `alert_event` row (state `firing`) is written and its channels fire.
 * - RECOVERY (value back to normal): the open firing event flips to `resolved`
 *   (`resolved_at` set) — this is the firing → resolved transition of PRD §42.
 * - STEADY: nothing is written; an alert that keeps breaching keeps ONE open
 *   firing event (re-evaluation is idempotent — the queue may redeliver).
 *
 * Channels (PRD §42): `inapp` is always on (the `alert_event` row IS the
 * in-app surface); `email` writes an `alert_email` system_event that the ops
 * mailer consumes; `webhook` fans out through `dispatchEvent` with the event
 * that matches the condition family (`budget.threshold`, `credit.low` or
 * `request.failed`).
 */

export type AlertConditionType =
	| 'error_rate'
	| 'latency'
	| 'budget_threshold'
	| 'credit_threshold'
	| 'fallback_rate'
	| 'provider_availability'
	| 'unusual_key_traffic';

export interface AlertCondition {
	type: AlertConditionType;
	/** The value that opens a firing event. Units depend on `type` (below). */
	threshold: number;
	/** Lookback window for the rate/latency conditions (default 300s). */
	window_seconds?: number;
	/** `error_rate|fallback_rate` baselines for unusual_key_traffic (ratio). */
	baseline_rate?: number;
}

/** Units per condition: ratio (0–1), ms, micro-units, ratio, ratio, ratio, ratio. */
const CONDITION_UNITS: Record<AlertConditionType, string> = {
	error_rate: 'ratio',
	latency: 'ms',
	budget_threshold: 'micro',
	credit_threshold: 'micro',
	fallback_rate: 'ratio',
	provider_availability: 'ratio',
	unusual_key_traffic: 'ratio'
};

/** Which webhook event a condition family announces (PRD §43). */
const CONDITION_WEBHOOK_EVENT: Record<AlertConditionType, WebhookEvent> = {
	error_rate: 'request.failed',
	latency: 'request.failed',
	budget_threshold: 'budget.threshold',
	credit_threshold: 'credit.low',
	fallback_rate: 'routing.failover',
	provider_availability: 'provider.degraded',
	unusual_key_traffic: 'request.failed'
};

export interface Measurement {
	/** The measured value in the condition's unit; null = not measurable now. */
	value: number | null;
	/** Breach direction: `above` crosses upward, `below` crosses downward. */
	direction: 'above' | 'below';
	message: string;
}

export interface EvaluationOutcome {
	alertId: string;
	condition: AlertConditionType;
	value: number | null;
	transition: 'firing' | 'resolved' | 'none';
	alertEventId: string | null;
}

const DEFAULT_WINDOW_SECONDS = 300;

/**
 * Measure one condition inside the account scope of `alertRow`.
 *
 * Pure-ish: reads the aggregates, returns a number + breach direction. The
 * unit of `value` is pinned per type in `CONDITION_UNITS` — comparisons are
 * threshold-vs-value in that unit and `budget_threshold` breaches when spend
 * GROWS past the threshold of the period budget, so it flips to `below` only
 * for the balance-shaped `credit_threshold` (low balance = value falling under
 * the threshold).
 *
 * Scope is the user account (migration 0019): `request_log` carries no
 * workspace/project columns, so `user_id` is what an alert can be scoped by.
 */
export async function measureCondition(
	alertRow: { accountId: string | null; condition: Record<string, unknown> },
	handle: JobHandle = db
): Promise<Measurement> {
	const cond = alertRow.condition as Partial<AlertCondition>;
	const type = cond.type as AlertConditionType;
	const threshold = Number(cond.threshold ?? 0);
	const windowSeconds = Number(cond.window_seconds ?? DEFAULT_WINDOW_SECONDS);
	const since = new Date(Date.now() - windowSeconds * 1000);
	const scope = [
		alertRow.accountId === null ? sql`true` : eq(requestLog.userId, alertRow.accountId),
		gte(requestLog.createdAt, since)
	];

	if (type === 'error_rate' || type === 'fallback_rate' || type === 'unusual_key_traffic') {
		const rows = await handle
			.select({
				total: sql<string>`count(*)::bigint`,
				errors: sql<string>`count(*) filter (where ${requestLog.status} <> 'success')::bigint`,
				fallbacks: sql<string>`count(*) filter (where ${requestLog.fallbackUsed})::bigint`
			})
			.from(requestLog)
			.where(and(...scope));
		const total = Number(rows[0]?.total ?? 0);
		if (total === 0) return { value: null, direction: 'above', message: 'no traffic in window' };
		if (type === 'error_rate') {
			const value = Number(rows[0]?.errors ?? 0) / total;
			return {
				value,
				direction: 'above',
				message: `error rate ${(value * 100).toFixed(1)}% over ${windowSeconds}s (${rows[0]?.errors}/${total})`
			};
		}
		if (type === 'fallback_rate') {
			const value = Number(rows[0]?.fallbacks ?? 0) / total;
			return {
				value,
				direction: 'above',
				message: `fallback rate ${(value * 100).toFixed(1)}% over ${windowSeconds}s (${rows[0]?.fallbacks}/${total})`
			};
		}
		// unusual_key_traffic: traffic share of the busiest key vs the
		// `baseline_rate` (default 50%) — a single key swamping the workspace is
		// the compromise signal (PRD §42/§70).
		const keys = await handle
			.select({
				apiKeyId: requestLog.apiKeyId,
				n: sql<string>`count(*)::bigint`
			})
			.from(requestLog)
			.where(and(...scope, sql`${requestLog.apiKeyId} is not null`))
			.groupBy(requestLog.apiKeyId)
			.orderBy(sql`count(*) desc`)
			.limit(1);
		const top = keys[0];
		if (!top) return { value: null, direction: 'above', message: 'no keyed traffic in window' };
		const value = Number(top.n) / total;
		const baseline = Number(cond.baseline_rate ?? 0.5);
		return {
			value,
			direction: 'above',
			message: `key ${top.apiKeyId} carries ${(value * 100).toFixed(1)}% of ${total} requests in ${windowSeconds}s (baseline ${(baseline * 100).toFixed(0)}%)`
		};
	}

	if (type === 'latency') {
		const rows = await handle
			.select({ avg: sql<string>`coalesce(avg(${requestLog.latencyMs}), 0)` })
			.from(requestLog)
			.where(and(...scope));
		const value = Number(rows[0]?.avg ?? 0);
		return {
			value: Number.isFinite(value) ? value : null,
			direction: 'above',
			message: `average latency ${Math.round(value)}ms over ${windowSeconds}s`
		};
	}

	if (type === 'budget_threshold' || type === 'credit_threshold') {
		const accounts = await handle
			.select({
				id: billingAccount.id,
				balance: billingAccount.balanceMicro,
				warn: billingAccount.warningThresholdMicro
			})
			.from(billingAccount)
			.where(eq(billingAccount.userId, alertRow.accountId ?? ''))
			.limit(1);
		const account = accounts[0];
		if (!account) return { value: null, direction: 'above', message: 'no billing account' };
		if (type === 'credit_threshold') {
			const value = Number(account.balance);
			return {
				value,
				direction: 'below',
				message: `credit balance ${value} micro-units (threshold ${threshold})`
			};
		}
		// budget_threshold: period spend from the rollup vs the period budget.
		const periodStart = new Date();
		periodStart.setUTCDate(1);
		periodStart.setUTCHours(0, 0, 0, 0);
		const rows = await handle
			.select({ spend: sql<string>`coalesce(sum(${usageHourly.costMicro}), 0)` })
			.from(usageHourly)
			.where(
				and(
					gte(usageHourly.bucketStart, periodStart),
					alertRow.accountId === null
						? sql`true`
						: eq(usageHourly.accountId, alertRow.accountId)
				)
			);
		const spend = Number(rows[0]?.spend ?? 0);
		const budgets = await handle
			.select({ amount: budget.amountMicro })
			.from(budget)
			.where(and(eq(budget.scope, 'account'), eq(budget.scopeId, alertRow.accountId ?? '')))
			.limit(1);
		const amount = Number(budgets[0]?.amount ?? 0) || threshold;
		const value = amount > 0 ? spend / amount : 0;
		return {
			value,
			direction: 'above',
			message: `period spend ${spend} of ${amount} micro-units (${(value * 100).toFixed(1)}%)`
		};
	}

	// provider_availability: success ratio over the window (low = degraded).
	const rows = await handle
		.select({
			total: sql<string>`count(*)::bigint`,
			ok: sql<string>`count(*) filter (where ${requestLog.status} = 'success')::bigint`
		})
		.from(requestLog)
		.where(and(...scope));
	const total = Number(rows[0]?.total ?? 0);
	if (total === 0) return { value: null, direction: 'below', message: 'no traffic in window' };
	const value = Number(rows[0]?.ok ?? 0) / total;
	return {
		value,
		direction: 'below',
		message: `provider availability ${(value * 100).toFixed(1)}% over ${windowSeconds}s (${rows[0]?.ok}/${total})`
	};
}

/**
 * Evaluate every enabled alert once (the `alert_evaluation` job handler).
 * Idempotent: running it twice in a row writes at most one firing event per
 * alert — the second run sees the open event and a steady breach.
 */
export async function evaluateAlerts(): Promise<EvaluationOutcome[]> {
	const alerts = await db.select().from(alert).where(eq(alert.enabled, true));
	const outcomes: EvaluationOutcome[] = [];
	for (const a of alerts) {
		const measurement = await measureCondition(a, db);
		const cond = a.condition as Partial<AlertCondition>;
		const type = (cond.type ?? 'error_rate') as AlertConditionType;
		const threshold = Number(cond.threshold ?? 0);
		const open = await db
			.select({ id: alertEvent.id })
			.from(alertEvent)
			.where(and(eq(alertEvent.alertId, a.id), eq(alertEvent.state, 'firing')))
			.orderBy(sql`${alertEvent.triggeredAt} desc`)
			.limit(1);
		const breach =
			measurement.value !== null &&
			(measurement.direction === 'above'
				? measurement.value >= threshold
				: measurement.value <= threshold);

		if (breach && open.length === 0) {
			const eventId = newId('ale_');
			await db.insert(alertEvent).values({
				id: eventId,
				alertId: a.id,
				triggeredAt: new Date(),
				value: String(measurement.value),
				message: measurement.message,
				state: 'firing'
			});
			await notifyChannels(a, type, measurement, eventId);
			outcomes.push({
				alertId: a.id,
				condition: type,
				value: measurement.value,
				transition: 'firing',
				alertEventId: eventId
			});
			continue;
		}
		if (!breach && open.length > 0) {
			const eventId = open[0].id;
			await db
				.update(alertEvent)
				.set({ state: 'resolved', resolvedAt: new Date(), message: measurement.message })
				.where(eq(alertEvent.id, eventId));
			outcomes.push({
				alertId: a.id,
				condition: type,
				value: measurement.value,
				transition: 'resolved',
				alertEventId: eventId
			});
			continue;
		}
		outcomes.push({
			alertId: a.id,
			condition: type,
			value: measurement.value,
			transition: 'none',
			alertEventId: open[0]?.id ?? null
		});
	}
	return outcomes;
}

/**
 * Fan a firing event out on the alert's channel (PRD §42). `inapp` needs no
 * work — the `alert_event` row is the surface. `email` leaves a system_event
 * for the ops mailer (PRD §77: durable events, not an event bus). `webhook`
 * reuses the delivery pipeline.
 */
async function notifyChannels(
	a: { id: string; name: string; channel: string; accountId: string | null },
	type: AlertConditionType,
	m: Measurement,
	eventId: string
): Promise<void> {
	if (a.channel === 'email') {
		await db.insert(systemEvent).values({
			id: newId('evt_'),
			type: 'alert_email',
			resource: 'alert',
			resourceId: a.id,
			// 0019 stopped writing system_event.workspace_id: it is an opaque
			// historical column with no FK, and the alert id already scopes it.
			metadata: { alertEventId: eventId, name: a.name, message: m.message, value: m.value }
		});
		await db.update(alertEvent).set({ deliveredAt: new Date() }).where(eq(alertEvent.id, eventId));
		return;
	}
	if (a.channel === 'webhook') {
		await dispatchEvent(CONDITION_WEBHOOK_EVENT[type], {
			accountId: a.accountId,
			alertId: a.id,
			alertEventId: eventId,
			condition: type,
			threshold: CONDITION_UNITS[type],
			value: m.value,
			message: m.message
		});
		await db.update(alertEvent).set({ deliveredAt: new Date() }).where(eq(alertEvent.id, eventId));
	}
}
