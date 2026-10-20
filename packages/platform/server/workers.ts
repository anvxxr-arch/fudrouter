import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import {
	auditLog,
	billingAccount,
	connection,
	credential,
	creditLedger,
	invoice,
	job,
	pricingRule,
	providerModel,
	requestLog,
	systemEvent,
	usageDaily,
	usageHourly,
	modelVerification
} from './db/schema.ts';
import { db } from './db/index.ts';
import {
	claimJobs,
	completeJob,
	enqueue,
	failJob,
	getJob,
	requeueStaleJobs,
	STALE_AFTER_MS_DEFAULT,
	type JobHandle,
	type JobRow,
	type JobType
} from './jobs.ts';
import { evaluateAlerts } from './alerts.ts';
import { deliverWebhook, pendingDeliveriesReady } from './webhooks.ts';
import { getSetting } from './settings.ts';
import { newId } from './id.ts';
import { decryptCredentials, type Credentials } from './credentials.ts';
import { headersFor, isExpiredOAuth, tokenAt } from './provider-credentials.ts';
import {
	fetchUpstreamCatalog,
	getProvider,
	UPSTREAM_TIMEOUT_MS
} from './provider-catalog-fetch.ts';
import { allowPrivateUpstreams } from './publish-env.ts';
import { guardedUpstreamFetch } from './ssrf.ts';
import { reconcileAll } from './billing.ts';

/**
 * Worker fleet (PRD §75–76, spec §11/§13).
 *
 * The loop claims jobs with `FOR UPDATE SKIP LOCKED` (jobs.ts), runs the
 * matching handler, and marks the row completed/failed — PostgreSQL holds every
 * byte of delivery state, so any number of these processes may run against the
 * same queue. Every handler must be IDEMPOTENT: the queue may redeliver a job
 * whose worker died after the side effect but before `completeJob`, so each
 * handler recomputes from source (aggregations), writes with conflict guards
 * (invoices) or checks durable state before acting (deliveries).
 *
 * Shutdown: `stop()` stops claiming and lets in-flight handlers finish; the
 * entrypoint (apps/workers/workers.mjs) wires SIGTERM/SIGINT to it.
 */

/** One job handler: `(dbtx, payload)`; `dbtx` is the app db or a transaction. */
export type JobHandler = (dbtx: JobHandle, payload: Record<string, unknown>) => Promise<void>;

/** Latency histogram bucket upper bounds (spec §8); `inf` holds the overflow. */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 60000];

/** `{"50": count, …, "inf": count}` — each key counts samples in `(prev, bound]`. */
const HISTOGRAM_SQL = sql<string>`jsonb_build_object(
	'50', count(*) filter (where ${requestLog.latencyMs} <= 50),
	'100', count(*) filter (where ${requestLog.latencyMs} > 50 and ${requestLog.latencyMs} <= 100),
	'250', count(*) filter (where ${requestLog.latencyMs} > 100 and ${requestLog.latencyMs} <= 250),
	'500', count(*) filter (where ${requestLog.latencyMs} > 250 and ${requestLog.latencyMs} <= 500),
	'1000', count(*) filter (where ${requestLog.latencyMs} > 500 and ${requestLog.latencyMs} <= 1000),
	'2500', count(*) filter (where ${requestLog.latencyMs} > 1000 and ${requestLog.latencyMs} <= 2500),
	'5000', count(*) filter (where ${requestLog.latencyMs} > 2500 and ${requestLog.latencyMs} <= 5000),
	'10000', count(*) filter (where ${requestLog.latencyMs} > 5000 and ${requestLog.latencyMs} <= 10000),
	'25000', count(*) filter (where ${requestLog.latencyMs} > 10000 and ${requestLog.latencyMs} <= 25000),
	'60000', count(*) filter (where ${requestLog.latencyMs} > 25000 and ${requestLog.latencyMs} <= 60000),
	'inf', count(*) filter (where ${requestLog.latencyMs} > 60000)
)`;

/**
 * Roll `request_log` into `usage_hourly` / `usage_daily` (PRD §96, spec §8).
 *
 * The rollup RECOMPUTES each touched bucket from the raw rows and upserts with
 * `ON CONFLICT … DO UPDATE` — never `count + excluded.count` — so re-running a
 * window (redelivery, overlap, crash after write) always converges to the truth
 * instead of inflating the aggregates. Dimensions are the spec §8 tuple; the
 * unique index is a COALESCE expression index, so the conflict target is too.
 */
const USAGE_DIMENSIONS = sql`"workspace_id", "project_id", "environment_id", "api_key_id",
	"model_id", "provider_id", "connection_id", "status", "endpoint"`;

async function rollupUsage(
	dbtx: JobHandle,
	table: typeof usageHourly | typeof usageDaily,
	trunc: 'hour' | 'day',
	from: Date,
	to: Date
): Promise<void> {
	const name = table === usageHourly ? 'usage_hourly' : 'usage_daily';
	// ISO strings, not Date params: drizzle's raw `execute` serialises through
	// postgres-js text mode, which has no Date encoder (typed queries do).
	const fromIso = from.toISOString();
	const toIso = to.toISOString();
	await dbtx.execute(sql`
		insert into ${sql.raw(name)} (
			"bucket_start", ${USAGE_DIMENSIONS},
			"requests", "successes", "tokens_in", "cached_input_tokens", "tokens_out",
			"reasoning_tokens", "total_tokens", "cost_micro", "latency_ms_sum",
			"latency_histogram", "ttft_ms_sum", "fallback_count", "retry_count", "updated_at"
		)
		select date_trunc('${sql.raw(trunc)}', "created_at"), ${USAGE_DIMENSIONS},
			count(*),
			count(*) filter (where "status" = 'success'),
			coalesce(sum(${requestLog.tokensIn}), 0),
			coalesce(sum(${requestLog.cachedInputTokens}), 0),
			coalesce(sum(${requestLog.tokensOut}), 0),
			coalesce(sum(${requestLog.reasoningTokens}), 0),
			coalesce(sum(${requestLog.totalTokens}), 0),
			coalesce(sum(${requestLog.cost}), 0),
			coalesce(sum(${requestLog.latencyMs}), 0),
			${HISTOGRAM_SQL},
			coalesce(sum(${requestLog.ttftMs}), 0),
			count(*) filter (where ${requestLog.fallbackUsed}),
			coalesce(sum(greatest(${requestLog.attempts} - 1, 0)), 0),
			now()
		from "request_log"
		where "created_at" >= ${fromIso}::timestamptz and "created_at" < ${toIso}::timestamptz
		group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
		on conflict (
			"bucket_start",
			coalesce("workspace_id", ''), coalesce("project_id", ''), coalesce("environment_id", ''),
			coalesce("api_key_id", ''), coalesce("model_id", ''), coalesce("provider_id", ''),
			coalesce("connection_id", ''), "status", "endpoint"
		) do update set
			"requests" = excluded."requests",
			"successes" = excluded."successes",
			"tokens_in" = excluded."tokens_in",
			"cached_input_tokens" = excluded."cached_input_tokens",
			"tokens_out" = excluded."tokens_out",
			"reasoning_tokens" = excluded."reasoning_tokens",
			"total_tokens" = excluded."total_tokens",
			"cost_micro" = excluded."cost_micro",
			"latency_ms_sum" = excluded."latency_ms_sum",
			"latency_histogram" = excluded."latency_histogram",
			"ttft_ms_sum" = excluded."ttft_ms_sum",
			"fallback_count" = excluded."fallback_count",
			"retry_count" = excluded."retry_count",
			"updated_at" = now()
	`);
}

/** Start of the UTC hour/day containing `d`. */
function floorTo(d: Date, trunc: 'hour' | 'day'): Date {
	const x = new Date(d);
	if (trunc === 'day') x.setUTCHours(0, 0, 0, 0);
	else x.setUTCMinutes(0, 0, 0);
	return x;
}

/**
 * `usage_aggregation`: rebuild hourly + daily buckets for a window.
 * Payload `{from?, to?}` (ISO strings); default = the last two hours ending now,
 * which is the window the periodic scheduler feeds it.
 *
 * `from` is FLOORED to the boundary of each granularity, because `rollupUsage`
 * upserts `requests = excluded.requests` — a bucket is REPLACED, never summed
 * into. The scheduler feeds `{}` every 5 minutes, so `from` defaults to `to-2h`;
 * passing that straight through for `trunc='day'` writes only the last two
 * hours of rows into today's day bucket and overwrites everything else, on
 * every single run. Measured before this fix: 363 requests in `request_log` for
 * the day against 16 in `usage_daily` (a 95.6% understatement) — and
 * `/api/admin/analytics` sums `usage_daily` and does NOT fall back to
 * `request_log` whenever the rollup has a row for the day, so the whole admin
 * dashboard under-reports. Flooring widens the window to the containing bucket
 * so every bucket the statement touches is fully covered, which makes the
 * replace-idempotent: re-running with `{}` recomputes today whole, and an
 * explicit backfill `from` merely gets widened down to its own bucket start
 * (never narrowed — no data is skipped).
 */
const usageAggregation: JobHandler = async (dbtx, payload) => {
	const to = payload.to ? new Date(String(payload.to)) : new Date();
	const from = payload.from
		? new Date(String(payload.from))
		: new Date(to.getTime() - 2 * 60 * 60 * 1000);
	await rollupUsage(dbtx, usageHourly, 'hour', floorTo(from, 'hour'), to);
	await rollupUsage(dbtx, usageDaily, 'day', floorTo(from, 'day'), to);
};

/**
 * `billing_aggregation`: recompute the `balance_micro` cache from
 * `credit_ledger` for every account (spec §10: the ledger is the record).
 * One set-based statement (`reconcileAll`) replaces the per-account loop —
 * N round trips collapsed to one, and the whole fleet is either repaired or
 * not (the loop could be killed halfway and leave caches half-old). The rule
 * is still written once in `reconcileAll`'s SQL.
 * Idempotent.
 */
const billingAggregation: JobHandler = async (dbtx) => {
	await reconcileAll(dbtx);
};

/**
 * `invoice_generation`: one `invoice` row per billing account for the period
 * (PRD §48). Payload `{periodStart?, periodEnd?, billingAccountId?}`; default =
 * the previous calendar month (UTC). Idempotent via the UNIQUE
 * (billing_account_id, period_start, period_end) index (migration 0016):
 * `ON CONFLICT DO NOTHING` on that target is the whole guard, so a redelivery
 * is a no-op by construction and two concurrent runs cannot both bill.
 */
const invoiceGeneration: JobHandler = async (dbtx, payload) => {
	const periodStart = payload.periodStart
		? new Date(String(payload.periodStart))
		: (() => {
				const d = new Date();
				d.setUTCDate(1);
				d.setUTCHours(0, 0, 0, 0);
				d.setUTCMonth(d.getUTCMonth() - 1);
				return d;
			})();
	const periodEnd = payload.periodEnd
		? new Date(String(payload.periodEnd))
		: (() => {
				const d = new Date(periodStart);
				d.setUTCMonth(d.getUTCMonth() + 1);
				return d;
			})();
	const accounts = await dbtx
		.select({
			id: billingAccount.id,
			currency: billingAccount.currency
		})
		.from(billingAccount)
		.where(
			payload.billingAccountId
				? eq(billingAccount.id, String(payload.billingAccountId))
				: sql`true`
		);
	const yyyymm = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
	for (const account of accounts) {
		const rows = await dbtx
			.select({ total: sql<string>`coalesce(-sum(${creditLedger.amountMicro}), 0)` })
			.from(creditLedger)
			.where(
				and(
					eq(creditLedger.billingAccountId, account.id),
					eq(creditLedger.type, 'usage_charge'),
					gte(creditLedger.createdAt, periodStart),
					lt(creditLedger.createdAt, periodEnd)
				)
			);
		// usage_charge postings are negative deltas (billing.ts, spec §10), so
		// the invoice amount is their negation.
		const amount = rows[0]?.total ?? '0';
		await dbtx
			.insert(invoice)
			.values({
				id: newId('inv_'),
				billingAccountId: account.id,
				// The FULL account id, not a suffix of it. `invoice.number` is
				// UNIQUE and this used to be `account.id.slice(-8)` — 8 hex
				// characters, 2^32 of them, shared by every billing account.
				// Two accounts whose ids agree in the last 8 characters produce
				// the same number, and `onConflictDoNothing` on that index then
				// dropped the SECOND account's invoice: an entire billing
				// account silently unbilled for the period, with no error and
				// no row to notice. Deriving the number from the primary key in
				// full is injective on the account, so within a period distinct
				// accounts can no longer collide. Existing rows keep their
				// 8-character numbers and cannot collide with these: the two
				// shapes differ in length.
				number: `INV-${yyyymm}-${account.id}`,
				periodStart,
				periodEnd,
				amountMicro: BigInt(amount),
				currency: account.currency,
				status: 'open',
				issuedAt: new Date()
			})
			.onConflictDoNothing({
				target: [invoice.billingAccountId, invoice.periodStart, invoice.periodEnd]
			});
	}
};

/**
 * `webhook_delivery`: move pending `webhook_delivery` rows toward their target
 * (PRD §43). With `deliveryId` in the payload that one row is attempted; the
 * bare form sweeps every row whose `next_attempt_at` has arrived. While pending
 * rows remain the handler queues its own follow-up at the earliest retry time,
 * so a delivery with no other traffic still gets retried (Valkey wake hints are
 * only hints — PostgreSQL schedules the truth, spec §11).
 */
const webhookDeliveryJob: JobHandler = async (_dbtx, payload) => {
	const ids = payload.deliveryId
		? [String(payload.deliveryId)]
		: await pendingDeliveriesReady();
	for (const id of ids) {
		await deliverWebhook(id);
	}
	const later = await pendingDeliveriesReady(new Date(Date.now() + 60_000));
	if (later.length > 0) {
		await enqueue(
			'webhook_delivery',
			{},
			{ maxAttempts: 1, availableAt: new Date(Date.now() + 30_000) },
			_dbtx
		);
	}
};

/** `alert_evaluation`: run every enabled alert rule once (PRD §42). */
const alertEvaluation: JobHandler = async () => {
	await evaluateAlerts();
};

// looksLikeModelsJSON reports whether a /models probe body is the JSON model
// listing an [OI]-compatible API returns. A 2xx HTML body means base_url points
// at a website, not an API.
function looksLikeModelsJSON(body: string): boolean {
	try {
		const parsed = JSON.parse(body);
		return typeof parsed === 'object' && parsed !== null;
	} catch {
		return false;
	}
}

/**
 * `provider_health_check`: probe each enabled connection's `base_url` (SSRF
 * guarded, PRD §121) and refresh `connection.health_status`, writing a
 * `system_event` ONLY on transition — a probe that keeps failing must not
 * manufacture an event per run.
 */
const providerHealthCheck: JobHandler = async (dbtx, payload) => {
	const rows = await dbtx
		.select({
			id: connection.id,
			providerId: connection.providerId,
			baseUrl: connection.baseUrl,
			timeoutMs: connection.timeoutMs,
			healthStatus: connection.healthStatus
		})
		.from(connection)
		.where(
			and(
				eq(connection.enabled, true),
				payload.connectionId ? eq(connection.id, String(payload.connectionId)) : sql`true`,
				payload.providerId ? eq(connection.providerId, String(payload.providerId)) : sql`true`
			)
		);
	for (const c of rows) {
		const probed = await guardedUpstreamFetch(c.baseUrl, allowPrivateUpstreams(), '/models', {
			method: 'GET',
			timeoutMs: Math.min(c.timeoutMs || UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS)
		});
		let status: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
		let detail: Record<string, unknown> = {};
		if (probed.ok) {
			const code = probed.response.status;
			const bodyText = await probed.response.text().catch(() => '');
			if (code >= 500) {
				status = 'unhealthy';
			} else if (code === 429) {
				status = 'degraded';
			} else if (code >= 200 && code < 300 && !looksLikeModelsJSON(bodyText)) {
				// A 2xx that is not the JSON model listing means base_url answers
				// with an HTML page (a marketing site or SPA fallback), so the
				// chat call cannot work either. Unhealthy keeps it out of the
				// candidate set instead of burning fallback attempts on it.
				status = 'unhealthy';
			} else {
				status = 'healthy';
			}
			detail = { httpStatus: code };
		} else {
			detail = { error: probed.message };
		}
		if (status !== c.healthStatus) {
			await dbtx
				.update(connection)
				.set({ healthStatus: status, updatedAt: new Date() })
				.where(eq(connection.id, c.id));
			await dbtx.insert(systemEvent).values({
				id: newId('evt_'),
				type: status === 'healthy' ? 'provider.recovered' : 'provider.degraded',
				resource: 'connection',
				resourceId: c.id,
				metadata: { providerId: c.providerId, from: c.healthStatus, to: status, ...detail }
			});
		} else {
			await dbtx
				.update(connection)
				.set({ updatedAt: new Date() })
				.where(eq(connection.id, c.id));
		}
	}
};

/**
 * How many credentials one `credential_validation` run probes.
 *
 * The table holds ~12k credentials and each probe is an upstream HTTP request,
 * so "validate everything" is not a job — it is an outage. Combined with the
 * per-connection fan-out in the scheduler, this bounds one run to
 * `batch × connections` requests instead of the whole population.
 *
 * The batch is paired with an `order by last_used_at asc nulls first` in the
 * query below, which makes the ordering a CURSOR: a probe stamps `lastUsedAt`,
 * so the next run naturally starts on the credentials this one did not reach.
 * No cursor state to persist, and never-validated rows (`null`) always go
 * first, so a cold table converges instead of starving.
 */
const CREDENTIAL_VALIDATION_BATCH = 250;

/**
 * How long a probe-detected failure withholds a credential from routing.
 *
 * The router's usable predicate is `status not in ('disabled','invalid') and
 * (cooldown_until is null or cooldown_until <= now())` — `auth_failed` is NOT an
 * exclusion on its own, so a failed probe that writes no cooldown leaves the
 * credential fully routable: the pool keeps selecting a key the probe just
 * rejected, eats a 401 on the request, and the next hourly probe re-finds the
 * same dead row. Mirror the data plane's `parkCredential` and set a cooldown;
 * keep it just under the hourly cadence so the next run re-tests rather than the
 * credential being parked forever on one bad probe.
 */
const CREDENTIAL_PROBE_COOLDOWN_MS = 55 * 60 * 1000;

/**
 * `credential_validation`: decrypt one credential (spec §4 envelope) and probe
 * its connection with the credential's own auth headers; map the response onto
 * the `credential.status` vocabulary and record the transition in a
 * `system_event`. Same "event only on change" rule as health checks.
 *
 * Payload: `{connectionId?, credentialId?}`. The scheduler enqueues one run per
 * enabled connection; the un-scoped form still works for a manual full sweep
 * but is bounded by `CREDENTIAL_VALIDATION_BATCH` per run, so it can no longer
 * hold the fleet behind a 12k-request loop.
 */
const credentialValidation: JobHandler = async (dbtx, payload) => {
	const rows = await dbtx
		.select({
			id: credential.id,
			connectionId: credential.connectionId,
			name: credential.name,
			secretEnc: credential.secretEnc,
			status: credential.status
		})
		.from(credential)
		.where(
			and(
				payload.credentialId
					? eq(credential.id, String(payload.credentialId))
					: sql`true`,
				payload.connectionId
					? eq(credential.connectionId, String(payload.connectionId))
					: sql`true`
			)
		)
		// Least-recently-validated first. This used to order by `lastUsedAt`,
		// which the probe itself stamps on every run (line ~570) — so after the
		// nulls drained, the cursor stopped advancing and the same 250 rows
		// were re-probed hourly with no progress. `lastValidatedAt` is written
		// only by this handler, so the ordering is a cursor the probe cannot
		// disturb, and it no longer pollutes the router's LRU signal either.
		.orderBy(sql`${credential.lastValidatedAt} asc nulls first`, credential.id)
		.limit(CREDENTIAL_VALIDATION_BATCH);
	const conns = new Map(
		(
			await dbtx
				.select({
					id: connection.id,
					baseUrl: connection.baseUrl,
					timeoutMs: connection.timeoutMs
				})
				.from(connection)
				.where(
					payload.connectionId
						? eq(connection.id, String(payload.connectionId))
						: sql`true`
				)
		).map((c) => [c.id, c])
	);
	// Memoised per connection, because a 2xx from /models is not evidence on its
	// own: some providers serve it publicly (openrouter, kiraai), so the same 200
	// comes back for a valid key, an invalid key, and no key at all. Asking once
	// per connection per run keeps the verdict honest for the price of one extra
	// request, instead of one extra request per credential.
	const publicModels = new Map<string, boolean>();
	const servesModelsAnonymously = async (conn: {
		id: string;
		baseUrl: string;
		timeoutMs: number | null;
	}) => {
		const cached = publicModels.get(conn.id);
		if (cached !== undefined) return cached;
		const anon = await guardedUpstreamFetch(conn.baseUrl, allowPrivateUpstreams(), '/models', {
			method: 'GET',
			timeoutMs: Math.min(conn.timeoutMs || UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS)
		});
		const isPublic = anon.ok && anon.response.status < 300;
		if (anon.ok) await anon.response.text().catch(() => '');
		publicModels.set(conn.id, isPublic);
		return isPublic;
	};
	for (const cred of rows) {
		const conn = conns.get(cred.connectionId);
		if (!conn) continue;
		let plain: Credentials;
		try {
			plain = decryptCredentials(cred.secretEnc);
		} catch (e) {
			// An undecryptable credential is still a VALIDATED credential: the
			// probe examined it and reached a verdict (`invalid`). Stamping
			// `lastValidatedAt` here keeps the cursor advancing past rows that
			// can never decrypt — otherwise they sit at NULL forever and the
			// batch re-selects the same undecryptable rows every run.
			await dbtx
				.update(credential)
				.set({ status: 'invalid', lastValidatedAt: new Date(), lastErrorAt: new Date(), updatedAt: new Date() })
				.where(eq(credential.id, cred.id));
			await dbtx.insert(systemEvent).values({
				id: newId('evt_'),
				type: 'credential.invalid',
				resource: 'credential',
				resourceId: cred.id,
				metadata: { error: e instanceof Error ? e.message : 'undecryptable' }
			});
			continue;
		}
		const probed = await guardedUpstreamFetch(conn.baseUrl, allowPrivateUpstreams(), '/models', {
			method: 'GET',
			headers: headersFor(plain, tokenAt(plain, 0)),
			timeoutMs: Math.min(conn.timeoutMs || UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS)
		});
		let status: 'healthy' | 'rate_limited' | 'auth_failed' | 'invalid' | 'unknown' = 'unknown';
		const detail: Record<string, unknown> = {};
		if (probed.ok) {
			const code = probed.response.status;
			await probed.response.text().catch(() => '');
			detail.httpStatus = code;
			status =
				code < 300
					? 'healthy'
					: code === 429
						? 'rate_limited'
						: code === 401 || code === 403
							? 'auth_failed'
							: code === 400 || code === 404
								? 'invalid'
								: 'unknown';
			// A 2xx here only means something if /models actually requires auth;
			// see `servesModelsAnonymously`.
			if (status === 'healthy' && (await servesModelsAnonymously(conn))) {
				status = 'unknown';
				detail.note = 'the provider serves /models without auth, so a 200 cannot confirm the credential';
			}
		} else {
			detail.error = probed.message;
		}
		// An OAuth account whose access token has expired cannot be judged by a
		// probe: the data plane refreshes it from `refresh_token` on demand, so a
		// 401 here is the stale token, not a dead account. Recording it as
		// `auth_failed` would be a false negative on a live credential.
		if (isExpiredOAuth(plain)) {
			status = 'unknown';
			detail.note = 'access token expired; the data plane refreshes it from refresh_token';
		}
		const now = new Date();
		// A failing verdict must actually withhold the credential — see
		// CREDENTIAL_PROBE_COOLDOWN_MS. Clearing it on a passing verdict also
		// un-parks a credential the data plane had cooled down.
		const failing = status === 'auth_failed' || status === 'rate_limited';
		await dbtx
			.update(credential)
			.set({
				status,
				lastValidatedAt: now,
				lastSuccessAt: status === 'healthy' ? now : undefined,
				lastErrorAt: status === 'healthy' ? undefined : now,
				cooldownUntil: failing ? new Date(now.getTime() + CREDENTIAL_PROBE_COOLDOWN_MS) : null,
				updatedAt: now
			})
			.where(eq(credential.id, cred.id));
		if (status !== cred.status) {
			await dbtx.insert(systemEvent).values({
				id: newId('evt_'),
				type: `credential.${status}`,
				resource: 'credential',
				resourceId: cred.id,
				metadata: { from: cred.status, to: status, name: cred.name, ...detail }
			});
		}
	}
};

/**
 * `provider_model_sync` (PRD §126): fetch the upstream catalog and DIFF it
 * against `provider_model`, recording additions / removals / changes in a
 * `system_event`. Report-only by contract: a removal must NEVER auto-delete a
 * row (spec §5 — history and pricing hang off it), and an addition is not
 * auto-linked to a canonical `model` (that is the admin publish flow), so the
 * sync surfaces the delta and stops. Payload: `{providerId, credentialIndex?}`.
 */
const providerModelSync: JobHandler = async (dbtx, payload) => {
	const providerId = String(payload.providerId ?? '');
	if (!providerId) throw new Error('provider_model_sync requires payload.providerId');
	const providerRow = await getProvider(providerId);
	if (!providerRow) throw new Error(`unknown provider ${providerId}`);
	const conns = await dbtx
		.select({
			id: connection.id,
			baseUrl: connection.baseUrl
		})
		.from(connection)
		.where(eq(connection.providerId, providerId))
		.orderBy(connection.priority, connection.id)
		.limit(1);
	const baseUrl = conns[0]?.baseUrl ?? providerRow.baseUrl;
	const creds = await dbtx
		.select({ secretEnc: credential.secretEnc })
		.from(credential)
		.where(conns[0] ? eq(credential.connectionId, conns[0].id) : sql`true`)
		.orderBy(credential.priority, credential.id);
	const index = Number(payload.credentialIndex ?? 0);
	const secretEnc = creds[index]?.secretEnc ?? creds[0]?.secretEnc;
	const catalog = await fetchUpstreamCatalog(
		baseUrl,
		secretEnc ? decryptCredentials(secretEnc) : {},
		index
	);
	const existing = await dbtx
		.select({
			id: providerModel.id,
			providerModelId: providerModel.providerModelId,
			enabled: providerModel.enabled,
			status: providerModel.status
		})
		.from(providerModel)
		.where(eq(providerModel.providerId, providerId));
	const known = new Map(existing.map((m) => [m.providerModelId, m]));
	const seen = new Set<string>();
	const additions: string[] = [];
	const changes: { id: string; context: number | null }[] = [];
	for (const m of catalog.models) {
		seen.add(m.slug);
		const row = known.get(m.slug);
		if (!row) {
			additions.push(m.slug);
			continue;
		}
		if (row.status !== 'available' || !row.enabled) {
			changes.push({ id: row.id, context: m.context });
		}
	}
	const removals = existing.filter((m) => !seen.has(m.providerModelId)).map((m) => m.providerModelId);
	await dbtx.insert(systemEvent).values({
		id: newId('evt_'),
		type: 'provider_model_sync',
		resource: 'provider',
		resourceId: providerId,
		metadata: {
			additions,
			removals,
			changes: changes.map((c) => c.id),
			catalogSize: catalog.models.length,
			checked: existing.length
		}
	});
};

/**
 * `pricing_sync` (PRD §127): apply a PROPOSED price set as a NEW version of
 * each `pricing_rule` — history is never mutated (spec §6: the open row gets
 * `effective_until`, a new version row is inserted).
 *
 * The job is the `apply` step of preview → approve → apply: the console renders
 * the preview diff, the operator approves, and only then is a job queued with
 * `payload.rules = [{modelId, providerModelId?, currency, inputPriceMicro,
 * cachedInputPriceMicro?, outputPriceMicro, reasoningPriceMicro?}]`. Running it
 * twice with the same proposal is a no-op the second time (open row already has
 * those prices), so a redelivery cannot bump the version twice.
 */
const pricingSync: JobHandler = async (dbtx, payload) => {
	const rules = Array.isArray(payload.rules) ? (payload.rules as Record<string, unknown>[]) : [];
	const effectiveFrom = payload.effectiveFrom ? new Date(String(payload.effectiveFrom)) : new Date();
	const createdBy = payload.createdBy ? String(payload.createdBy) : null;
	for (const proposed of rules) {
		const modelId = String(proposed.modelId ?? '');
		if (!modelId) throw new Error('pricing_sync rule requires modelId');
		const providerModelId = proposed.providerModelId ? String(proposed.providerModelId) : null;
		const open = await dbtx
			.select()
			.from(pricingRule)
			.where(
				and(
					eq(pricingRule.modelId, modelId),
					providerModelId === null
						? isNull(pricingRule.providerModelId)
						: eq(pricingRule.providerModelId, providerModelId),
					isNull(pricingRule.effectiveUntil)
				)
			)
			.orderBy(desc(pricingRule.version))
			.limit(1);
		const current = open[0] ?? null;
		const same =
			current !== null &&
			current.inputPrice === String(proposed.inputPriceMicro ?? '') &&
			current.outputPrice === String(proposed.outputPriceMicro ?? '');
		if (same) continue;
		const versions = await dbtx
			.select({ version: pricingRule.version })
			.from(pricingRule)
			.where(
				and(
					eq(pricingRule.modelId, modelId),
					providerModelId === null
						? isNull(pricingRule.providerModelId)
						: eq(pricingRule.providerModelId, providerModelId)
				)
			)
			.orderBy(desc(pricingRule.version))
			.limit(1);
		const version = (versions[0]?.version ?? 0) + 1;
		if (current) {
			await dbtx
				.update(pricingRule)
				.set({ effectiveUntil: effectiveFrom })
				.where(eq(pricingRule.id, current.id));
		}
		await dbtx.insert(pricingRule).values({
			id: newId('prc_'),
			modelId,
			providerModelId,
			version,
			currency: String(proposed.currency ?? 'USD'),
			inputPrice: String(proposed.inputPriceMicro ?? '0'),
			cachedInputPrice:
				proposed.cachedInputPriceMicro === undefined || proposed.cachedInputPriceMicro === null
					? null
					: String(proposed.cachedInputPriceMicro),
			outputPrice: String(proposed.outputPriceMicro ?? '0'),
			reasoningPrice:
				proposed.reasoningPriceMicro === undefined || proposed.reasoningPriceMicro === null
					? null
					: String(proposed.reasoningPriceMicro),
			effectiveFrom,
			createdBy
		});
	}
	await dbtx.insert(systemEvent).values({
		id: newId('evt_'),
		type: 'pricing_sync',
		resource: 'pricing_rule',
		resourceId: null,
		metadata: { applied: rules.length, effectiveFrom: effectiveFrom.toISOString() }
	});
};

/**
 * How many provider_model rows ONE `model_verification` run probes.
 *
 * The upstream catalog holds a few hundred mappings per commercial provider and
 * every probe is a real (if tiny) billed chat completion, so an unbounded run
 * would both hold one job row for minutes and spend real tokens on a schedule.
 * Bounded and least-recently-verified first (the order-by cursor below), so
 * coverage rotates across runs instead of re-probing the same head rows
 * — the same cursor discipline `credential_validation` uses.
 */
export const MODEL_VERIFICATION_BATCH = 100;

/**
 * `model_verification`: detect a provider serving a DIFFERENT model than its
 * catalog advertises (relabeled, aliased, or wrong-capability), or not serving
 * it at all.
 *
 * Why this job exists: `provider_model` rows are a CLAIM copied from the
 * upstream `/models` listing — nothing ever proves the upstream serves that
 * slug under that name. When a provider quietly swaps the backing model, every
 * user routed to it silently gets wrong answers, and `request_log` cannot see
 * it: it records the slug we ASKED for (`requested_model`), not what came back.
 *
 * The probe goes through the SAME internal upstream seam the health check uses
 * (`guardedUpstreamFetch` + the connection's own decrypted credential), never
 * through the public router hot path: a verification probe must not consume a
 * user's budget, hit the rate limiter, or rotate the credential pool — and the
 * health-check seam already carries the SSRF guard, the no-redirect rule and
 * the timeout, so a new call site cannot forget any of them.
 *
 * Evidence is one append-only `model_verification` row per probe (0018):
 * requested slug vs the response body's own `model` field, tokens, latency,
 * verdict. The verdict is STRICT string equality against the requested slug by
 * design — a provider answering `gpt-4o-mini-2024-07-18` to `gpt-4o-mini` may
 * be fine (a dated snapshot) or may be a swap, and only a human looking at the
 * recorded `response_model` can judge; the job's job is to record, not to
 * decide. Verdicts: `pass` (served under the advertised name), `mismatch`
 * (served, but a different name), `not_served` (auth-rejected or the model is
 * unknown to the upstream), `error` (transient — 5xx/429/timeout/undecryptable
 * credential — which proves nothing about what is served and must never be
 * collapsed into `not_served` or the evidence trail lies).
 *
 * Payload: `{providerId}` — required, matching the scheduler's provider-scoped
 * fan-out and the admin `POST providers/:id/verify`. Idempotent: each run
 * appends fresh rows and readers take the newest per mapping.
 */
const modelVerificationJob: JobHandler = async (dbtx, payload) => {
	const providerId = String(payload.providerId ?? '');
	if (!providerId) throw new Error('model_verification requires payload.providerId');
	// `lastVerified` doubles as the progress cursor, exactly like
	// `credential_validation`'s `lastValidatedAt`: it is derived from THIS
	// table's own rows, which nothing else writes, so probing cannot disturb
	// the ordering that decides what gets probed next. The correlated
	// subquery is per-row on a table bounded by MODEL_VERIFICATION_BATCH.
	const mappings = await dbtx
		.select({
			id: providerModel.id,
			upstreamSlug: providerModel.providerModelId,
			connectionId: providerModel.connectionId
		})
		.from(providerModel)
		.where(and(eq(providerModel.providerId, providerId), eq(providerModel.enabled, true)))
		.orderBy(
			sql`coalesce((select max(${modelVerification.createdAt}) from ${modelVerification} where ${modelVerification.providerModelId} = ${providerModel.id}), to_timestamp(0))`,
			providerModel.id
		)
		.limit(MODEL_VERIFICATION_BATCH);
	if (mappings.length === 0) return;
	const conns = await dbtx
		.select({
			id: connection.id,
			baseUrl: connection.baseUrl,
			timeoutMs: connection.timeoutMs
		})
		.from(connection)
		.where(and(eq(connection.providerId, providerId), eq(connection.enabled, true)))
		.orderBy(connection.priority, connection.id);
	// A provider_model.connection_id of NULL means "any connection of this
	// provider" (the COALESCE uniqueness index in 0006 says the same); the
	// highest-priority enabled connection is the one routing would pick.
	const connById = new Map(conns.map((c) => [c.id, c]));
	const defaultConn = conns[0] ?? null;
	// Memoised per connection: one mapping's verdict must not spend one
	// credential decryption per mapping when mappings share a connection.
	const credCache = new Map<string, Credentials | null>();
	const usableCred = async (connId: string): Promise<Credentials | null> => {
		const cached = credCache.get(connId);
		if (cached !== undefined) return cached;
		const creds = await dbtx
			.select({ secretEnc: credential.secretEnc })
			.from(credential)
			.where(eq(credential.connectionId, connId))
			.orderBy(credential.priority, credential.id);
		let plain: Credentials | null = null;
		for (const c of creds) {
			try {
				plain = decryptCredentials(c.secretEnc);
				break;
			} catch {
				// An undecryptable credential is skipped, not fatal: another
				// credential on the same connection may still probe.
			}
		}
		credCache.set(connId, plain);
		return plain;
	};
	for (const m of mappings) {
		// The slug the catalog CLAIMS this mapping serves, and the only value
		// worth probing: it is what a user's request would carry upstream.
		const requestedSlug = m.upstreamSlug;
		const conn = (m.connectionId ? connById.get(m.connectionId) : null) ?? defaultConn;
		const latencyStart = Date.now();
		let verdict: 'pass' | 'mismatch' | 'not_served' | 'error';
		let responseModel: string | null = null;
		let error: string | null = null;
		let tokensIn: number | null = null;
		let tokensOut: number | null = null;
		if (!conn) {
			verdict = 'error';
			error = 'provider has no enabled connection to probe through';
		} else {
			const cred = await usableCred(conn.id);
			if (!cred) {
				verdict = 'error';
				error = 'connection has no decryptable credential to probe with';
			} else {
				const probed = await guardedUpstreamFetch(conn.baseUrl, allowPrivateUpstreams(), '/chat/completions', {
					method: 'POST',
					headers: { ...headersFor(cred, tokenAt(cred, 0)), 'content-type': 'application/json' },
					body: JSON.stringify({
						model: requestedSlug,
						messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
						max_tokens: 16
					}),
					timeoutMs: Math.min(conn.timeoutMs || UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS)
				});
				if (!probed.ok) {
					verdict = 'error';
					error = probed.message;
				} else {
					const code = probed.response.status;
					const bodyText = await probed.response.text().catch(() => '');
					if (code === 401 || code === 403) {
						// Auth-rejected: this credential cannot reach the model at
						// all, so the catalog entry is not served to anyone.
						verdict = 'not_served';
						error = `HTTP ${code}`;
					} else if (code === 404) {
						verdict = 'not_served';
						error = 'HTTP 404 (model unknown to upstream)';
					} else if (code >= 200 && code < 300) {
						// try/catch, not a `.catch()`: JSON.parse throws SYNCHRONOUSLY
						// on a non-JSON 2xx body (an HTML error page served with 200),
						// and an unparseable body must not abort the run for the
						// mappings not yet probed — it is recorded as a mismatch with
						// no response_model below.
						let data: unknown = null;
						try {
							data = bodyText ? JSON.parse(bodyText) : null;
						} catch {
							data = null;
						}
						const body = (data ?? {}) as Record<string, unknown>;
						const usage = (body.usage ?? {}) as Record<string, unknown>;
						responseModel = typeof body.model === 'string' ? body.model : null;
						tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
						tokensOut = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
						// A 2xx that names a different model is the exact bug this
						// job exists to catch. A 2xx with NO model field is not a
						// pass — an upstream that will not say what it served
						// cannot be vouched for, but it is also not proof of a
						// swap, so it is recorded as a mismatch with the field
						// left NULL rather than folded into `error`.
						verdict = responseModel === requestedSlug ? 'pass' : 'mismatch';
					} else {
						verdict = 'error';
						error = `HTTP ${code}`;
					}
				}
			}
		}
		await dbtx.insert(modelVerification).values({
			id: newId('mvr_'),
			providerModelId: m.id,
			requestedSlug,
			responseModel,
			verdict,
			error,
			tokensIn,
			tokensOut,
			latencyMs: Date.now() - latencyStart
		});
	}
};

/**
 * How many rows ONE retention statement touches.
 *
 * Why batching exists at all: the handler ran four unbounded statements and the
 * DELETE carried an FK check per removed `request_log` row. At 3B tokens/day
 * `request_log` is the largest table in the system, so a pass whose cutoff
 * matches millions of rows holds its snapshot, its indexes, its TOAST and every
 * pending FK check open for the whole pass — and it cannot be interrupted,
 * because `stop()` drains in-flight handlers rather than killing them, so
 * SIGTERM waits for the sweep.
 *
 * Batching makes each statement commit and release its locks. The work is
 * idempotent (it selects by age), so a sweep cut short is simply resumed by the
 * next run and partial progress is progress.
 *
 * 5,000 is sized against the measured per-row cost: the FK check on a deleted
 * `request_log` row measured ~5µs (17ms / 3,362 rows, and stable across query
 * plans), so one batch is ~25ms of trigger work plus an index seek. At 1M stale
 * rows that is 200 statements instead of one 5-second transaction.
 */
export const RETENTION_BATCH = 5_000;

/**
 * How many batches one sweep runs before yielding.
 *
 * Without a cap, the first sweep against a large backlog is an unbounded loop
 * that starves the rest of the queue. The caller reports whether it finished, so
 * an operator can tell "caught up" from "still draining" — silently stopping at
 * the border would be the same bug in a different costume.
 */
export const RETENTION_MAX_BATCHES = 200;

/**
 * retentionBatch touches `RETENTION_BATCH` aged rows at most: DELETEs them, or
 * (when `setClause` is given) blanks the named columns instead.
 *
 * `set` + a `where id in (select … limit N)` subquery is deliberate. A plain
 * `update|delete where <predicate>` has no limit, so it cannot be bounded; the
 * subquery form is what makes each statement bounded AND index-driven, which is
 * the pair that turns a full heap pass into a seek (measured 144ms -> 3ms on the
 * same 3,362 rows once `request_log_created_at_idx` exists).
 *
 * The cutoff is passed as an ISO STRING, not a Date. postgres-js accepts a Date
 * as a top-level argument (every drizzle `.where()` in this codebase relies on
 * that) but rejects one once it is nested inside a `sql.raw`-bearing fragment:
 * measured `code: 'ERR_INVALID_ARG_TYPE'` at Bind for `new Date(0)`, while
 * `.toISOString()` binds cleanly and casts to timestamptz by column context.
 */
async function retentionBatch(
	dbtx: JobHandle,
	table: string,
	dateCol: string,
	cutoffDate: Date,
	extraWhere = '',
	setClause?: string
): Promise<{ touched: number; more: boolean }> {
	let touched = 0;
	for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
		const ids = sql`select id from ${sql.identifier(table)}
			where ${sql.identifier(dateCol)} < ${cutoffDate.toISOString()} ${sql.raw(extraWhere)}
			limit ${RETENTION_BATCH}`;
		// `id` is the only column RETURNING, so the row count is the touched
		// count. postgres-js hands back an array-like RowList, hence the read
		// through `.length` rather than a drizzle builder's typed rows.
		const rows = (setClause
			? await dbtx.execute<{ id: string }>(sql`update ${sql.identifier(table)} set ${sql.raw(setClause)}
					where id in (${ids}) returning id`)
			: await dbtx.execute<{ id: string }>(sql`delete from ${sql.identifier(table)}
					where id in (${ids}) returning id`)) as unknown as Array<{ id: string }>;
		const n = rows.length;
		touched += n;
		// Fewer than a full batch means the window is empty: stop rather than
		// issuing one more statement that is guaranteed to match nothing.
		if (n < RETENTION_BATCH) return { touched, more: false };
	}
	return { touched, more: true };
}

/**
 * `data_retention_cleanup`: enforce `system_setting['retention']`
 * (PRD §93–94). Two different defaults on purpose — the PRD keeps REQUEST
 * METADATA always and makes content capture opt-in, while destroying rows must
 * never be a zero-config accident:
 *
 * - `request_content_days` scrubs `request_body`/`response_body` past the
 *   window; `0` (the seeded default) therefore scrubs ALL captured content —
 *   content is only kept while a positive window allows it.
 * - `request_metadata_days` / `system_events_days` / `audit_logs_days` / `job_days`
 *   DELETE rows past the window; `0`/negative keeps them forever (deletion is
 *   opt-in — a zero here must never mean "wipe the ledger"). `job_days` deletes
 *   only TERMINAL (`completed`/`failed`) queue rows, never live work.
 *
 * Idempotent: a second run finds nothing older than the same cutoffs. Every
 * branch is batched (see retentionBatch) and reports whether it finished, so a
 * long backlog drains across runs instead of in one unbounded transaction.
 */
const dataRetentionCleanup: JobHandler = async (dbtx) => {
	const retention = await getSetting('retention');
	const metadataDays = Number(retention?.request_metadata_days ?? 0);
	const contentDays = Number(retention?.request_content_days ?? 0);
	const eventDays = Number(retention?.system_events_days ?? 0);
	const auditDays = Number(retention?.audit_logs_days ?? 0);
	const jobDays = Number(retention?.job_days ?? 0);
	const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000);

	// Content first, then rows — the original order, now batched. Blanking is
	// batched for the same reason as deletion: it rewrites the two largest
	// columns, so one unbounded UPDATE rewrites the whole TOAST relation inside
	// a single transaction.
	const blanked = await retentionBatch(
		dbtx,
		'request_log',
		'created_at',
		cutoff(contentDays),
		'and (request_body is not null or response_body is not null)',
		'request_body = null, response_body = null'
	);

	let deletedRequests = 0;
	if (metadataDays > 0) {
		deletedRequests = (
			await retentionBatch(dbtx, 'request_log', 'created_at', cutoff(metadataDays))
		).touched;
	}
	let deletedEvents = 0;
	if (eventDays > 0) {
		deletedEvents = (await retentionBatch(dbtx, 'system_event', 'created_at', cutoff(eventDays))).touched;
	}
	let deletedAudits = 0;
	if (auditDays > 0) {
		deletedAudits = (await retentionBatch(dbtx, 'audit_log', 'created_at', cutoff(auditDays))).touched;
	}
	// `job` is an internal queue, not a ledger: its completed/failed rows are
	// pure history and grow ~3-4k/day forever (one row per webhook delivery,
	// alert evaluation, aggregation, probe). Delete only TERMINAL rows — a
	// pending/running job is live work and a sweep must never drop it.
	let deletedJobs = 0;
	if (jobDays > 0) {
		deletedJobs = (
			await retentionBatch(
				dbtx,
				'job',
				'created_at',
				cutoff(jobDays),
				"and status in ('completed', 'failed')"
			)
		).touched;
	}
	const unfinished =
		blanked.more ||
		(metadataDays > 0 && deletedRequests >= RETENTION_BATCH * RETENTION_MAX_BATCHES) ||
		(eventDays > 0 && deletedEvents >= RETENTION_BATCH * RETENTION_MAX_BATCHES) ||
		(auditDays > 0 && deletedAudits >= RETENTION_BATCH * RETENTION_MAX_BATCHES) ||
		(jobDays > 0 && deletedJobs >= RETENTION_BATCH * RETENTION_MAX_BATCHES);
	if (blanked.touched + deletedRequests + deletedEvents + deletedAudits + deletedJobs > 0) {
		await dbtx.insert(systemEvent).values({
			id: newId('evt_'),
			type: 'data_retention_cleanup',
			resource: 'system',
			resourceId: null,
			metadata: {
				blankedBodies: blanked.touched,
				deletedRequests,
				deletedEvents,
				deletedAudits,
				deletedJobs,
				metadataDays,
				contentDays,
				jobDays,
				// true = a window still had rows when the batch cap was reached, so
				// the next scheduled run continues. Distinguishes "caught up" from
				// "still draining" without a second query.
				unfinished
			}
		});
	}
};

/**
 * `statistics_aggregation`: provider/connection/credential health rollups over
 * the last 24h of `request_log` into one `system_event` per provider (PRD §19
 * status components read these snapshots). Idempotent — each run writes one
 * fresh snapshot row and readers take the newest per provider.
 */
const statisticsAggregation: JobHandler = async (dbtx) => {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const perProvider = await dbtx
		.select({
			providerId: requestLog.providerId,
			requests: sql<string>`count(*)::bigint`,
			successes: sql<string>`count(*) filter (where ${requestLog.status} = 'success')::bigint`,
			latencyAvg: sql<string>`coalesce(avg(${requestLog.latencyMs}), 0)`,
			fallbacks: sql<string>`count(*) filter (where ${requestLog.fallbackUsed})::bigint`
		})
		.from(requestLog)
		.where(gte(requestLog.createdAt, since))
		.groupBy(requestLog.providerId);
	const conns = await dbtx
		.select({
			providerId: connection.providerId,
			health: connection.healthStatus,
			n: sql<string>`count(*)::bigint`
		})
		.from(connection)
		.groupBy(connection.providerId, connection.healthStatus);
	const creds = await dbtx
		.select({
			providerId: connection.providerId,
			status: credential.status,
			n: sql<string>`count(*)::bigint`
		})
		.from(credential)
		.innerJoin(connection, eq(credential.connectionId, connection.id))
		.groupBy(connection.providerId, credential.status);
	for (const row of perProvider) {
		const connectionHealth: Record<string, number> = {};
		for (const c of conns) {
			if (c.providerId !== row.providerId) continue;
			connectionHealth[c.health] = Number(c.n);
		}
		const credentialStatus: Record<string, number> = {};
		for (const c of creds) {
			if (c.providerId !== row.providerId) continue;
			credentialStatus[c.status] = Number(c.n);
		}
		await dbtx.insert(systemEvent).values({
			id: newId('evt_'),
			type: 'statistics_rollup',
			resource: 'provider',
			resourceId: row.providerId,
			metadata: {
				window: '24h',
				requests: Number(row.requests),
				successes: Number(row.successes),
				latencyAvgMs: Math.round(Number(row.latencyAvg)),
				fallbacks: Number(row.fallbacks),
				connectionHealth,
				credentialStatus
			}
		});
	}
};

/** The PRD §76 job-type → handler registry. */
export const JOB_HANDLERS: Record<JobType, JobHandler> = {
	usage_aggregation: usageAggregation,
	billing_aggregation: billingAggregation,
	invoice_generation: invoiceGeneration,
	webhook_delivery: webhookDeliveryJob,
	alert_evaluation: alertEvaluation,
	provider_health_check: providerHealthCheck,
	credential_validation: credentialValidation,
	provider_model_sync: providerModelSync,
	pricing_sync: pricingSync,
	data_retention_cleanup: dataRetentionCleanup,
	statistics_aggregation: statisticsAggregation,
	model_verification: modelVerificationJob
};

/** Run one claimed job to completion/failure. */
export async function runJob(row: JobRow): Promise<'completed' | 'failed' | 'retrying'> {
	const handler = JOB_HANDLERS[row.type as JobType];
	if (!handler) {
		await failJob(row.id, `no handler registered for job type ${row.type}`);
		return 'failed';
	}
	try {
		await handler(db, row.payload);
		await completeJob(row.id);
		return 'completed';
	} catch (e) {
		await failJob(row.id, e instanceof Error ? (e.stack ?? e.message) : String(e));
		const after = await getJob(row.id);
		return after?.status === 'pending' ? 'retrying' : 'failed';
	}
}

export interface WorkerOptions {
	/** Which job types this worker drains (default: every PRD §76 type). */
	types?: JobType[];
	/** Jobs claimed and run in parallel per tick (default 1). */
	concurrency?: number;
	/** Sleep between empty polls (default 2s). */
	idleSleepMs?: number;
	/** A `running` job older than this is requeued (default 10min). */
	staleAfterMs?: number;
	onEvent?: (event: { kind: 'job'; id: string; type: string; outcome: string; error?: string }) => void;
}

export interface WorkerRuntime {
	run(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * The claim → run → settle loop. `stop()` is safe to call at any time: it flips
 * the running flag and wakes the sleep, then waits for in-flight handlers —
 * a job is never abandoned mid-flight (its row would stay `running` until the
 * stale sweep resurrects it).
 */
// ECONNRESET included: when the container is stopped, in-flight queries die
// with `read ECONNRESET` before the listener starts refusing (ECONNREFUSED).
// Both are the same outage at different instants.
//
// 3D000 (database does not exist) and 42P01 (relation does not exist) added
// after the Oct 19 2026 DB outage: neither is a *connection* failure, but a
// database mid-restore/mid-recreate serves exactly those codes while it is
// gone, and while they were absent the claim+sweep error rethrew out of the
// guard and crash-looped the worker fleet 32,801 restarts (~every 3s). A
// missing-database/relation window must back off like a connection outage.
// 42P01 can ALSO mean a genuine migration bug, so warnMissingObject logs its
// first occurrence per process loudly before the backoff can swallow it.
const CONNECTION_OUTAGE_RE = /3D000|42P01|57P03|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection refused|not yet accepting|terminating connection|connection terminated|connection reset|server closed the connection|too many clients|remaining connection slots/i;

// outageText flattens an error into the one string the outage matcher, the
// log hint and warnMissingObject all test, so the three can never disagree
// about what the error said.
function outageText(e: unknown): string {
	if (e instanceof Error) {
		let code = '';
		if ('code' in e) {
			const c = e.code;
			if (typeof c === 'string' || typeof c === 'number') code = ` ${c}`;
		}
		return `${e.message}${code} ${outageChainText(e.cause)}`;
	}
	return String(e);
}

// isConnectionOutage reports whether an error looks like the database being
// unreachable (restart, recovery, failover) rather than a bug in our SQL.
// Matched on message/code because drizzle/postgres-js surface transport
// failures as plain Errors with driver text, not a stable error class.
function isConnectionOutage(e: unknown): boolean {
	return CONNECTION_OUTAGE_RE.test(outageText(e));
}

// warnMissingObject fires once per process per code for the two SQLSTATEs that
// can be either an outage or a real bug (Oct 19: 3D000 crash loop, 32,801
// restarts): a wrong DATABASE_URL or an un-migrated table reads identically to
// a database mid-restore. Backing off instead of crash-looping must not
// silently swallow the genuine case, so the first sighting logs the full
// flattened error loudly.
const warnedMissingObject = new Set<string>();
function warnMissingObject(e: unknown): void {
	const text = outageText(e);
	for (const code of ['3D000', '42P01']) {
		if (warnedMissingObject.has(code) || !text.includes(code)) continue;
		warnedMissingObject.add(code);
		console.error(
			`[workers] Postgres ${code} (${code === '3D000' ? 'database does not exist' : 'relation does not exist'}) — first occurrence this process; backing off like an outage, but this can also be a real migration/config bug, not a transient: ${text.trim()}`
		);
	}
}

// outageChainText flattens an error's `cause` chain for outage matching and
// logging. drizzle/postgres-js wrap the transport failure: the driver text
// (ECONNREFUSED, 57P03) lives in the chain, not in `message` (which carries
// the SQL). Two call sites (matcher + log hint) must walk it identically.
//
// Each Error node's own `code` must be read too: a SQLSTATE (3D000, 42P01)
// lives on the wrapped PostgresError's `code` and appears nowhere in any
// message, and only the chain TAIL's code was read below — the tail of a
// drizzle-wrapped error is that PostgresError, an Error, so the code was
// silently dropped for exactly the Oct 19 codes this fix is about.
function outageChainText(cause: unknown): string {
	let text = '';
	let cur: unknown = cause;
	while (cur instanceof Error) {
		text += ` ${cur.message}`;
		if ('code' in cur) {
			const c = cur.code;
			if (typeof c === 'string' || typeof c === 'number') text += ` ${c}`;
		}
		cur = cur.cause;
	}
	if (typeof cur === 'object' && cur !== null && 'code' in cur) {
		const c = cur.code;
		if (typeof c === 'string' || typeof c === 'number') text += ` ${c}`;
	}
	return text;
}

export function createWorker(options: WorkerOptions = {}): WorkerRuntime {
	const types = options.types ?? (Object.keys(JOB_HANDLERS) as JobType[]);
	const concurrency = Math.max(1, options.concurrency ?? 1);
	const idleSleepMs = options.idleSleepMs ?? 2000;
	const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS_DEFAULT;
	let running = true;
	let inFlight: Promise<void> = Promise.resolve();
	let wake: (() => void) | null = null;

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				wake = null;
				resolve();
			}, ms);
			wake = () => {
				clearTimeout(timer);
				wake = null;
				resolve();
			};
		});

	return {
		async run() {
			let sinceSweep = 0;
			let backoffMs = 0;
			let loggedOutage = false;
			while (running) {
				// The claim + sweep are the only DB touches in the loop body.
				// A connection outage (Postgres restart/recovery, e.g. 57P03)
				// must back off and retry, not kill the loop: runJob/failJob
				// below already settle per-job errors, so only the claim path
				// needs this guard. Non-connection errors rethrow (a real bug
				// must stay loud).
				let claimed;
				try {
					if (Date.now() - sinceSweep > staleAfterMs / 2) {
						sinceSweep = Date.now();
						await requeueStaleJobs(staleAfterMs);
					}
					claimed = await claimJobs(types, concurrency);
				} catch (e) {
					if (!running) break;
					if (!isConnectionOutage(e)) throw e;
					// 3D000/42P01 are outage-shaped but can be a real
					// migration/config bug — scream the first time each
					// appears so the backoff below cannot hide it.
					warnMissingObject(e);
					backoffMs = backoffMs === 0 ? 5000 : Math.min(backoffMs * 2, 60000);
					if (!loggedOutage) {
						loggedOutage = true;
						// One short token, never a full stack or query string.
						// The hint regex IS CONNECTION_OUTAGE_RE (matched on
						// the same outageText the matcher saw) — a separate
						// short list here once drifted from the classifier.
						const text = outageText(e);
						const hint = text.match(CONNECTION_OUTAGE_RE)?.[0] ?? (e instanceof Error ? e.message.slice(0, 40) : 'unreachable');
						console.error(`[workers] database unreachable (${hint}) — retrying with backoff`);
					}
					await sleep(backoffMs);
					continue;
				}
				backoffMs = 0;
				loggedOutage = false;
				if (claimed.length === 0) {
					await sleep(idleSleepMs);
					continue;
				}
				inFlight = Promise.all(
					claimed.map(async (row) => {
						let outcome: string;
						try {
							outcome = await runJob(row);
						} catch (e) {
							outcome = 'failed';
							await failJob(row.id, e instanceof Error ? e.message : String(e)).catch(
								() => undefined
							);
						}
						options.onEvent?.({
							kind: 'job',
							id: row.id,
							type: row.type,
							outcome
						});
					})
				).then(() => undefined);
				await inFlight;
			}
		},
		async stop() {
			running = false;
			wake?.();
			await inFlight;
		}
	};
}
