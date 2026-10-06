import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import {
	auditLog,
	billingAccount,
	connection,
	credential,
	creditLedger,
	invoice,
	pricingRule,
	providerModel,
	requestLog,
	systemEvent,
	usageDaily,
	usageHourly
} from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import {
	claimJobs,
	completeJob,
	enqueue,
	failJob,
	getJob,
	requeueStaleJobs,
	type JobHandle,
	type JobRow,
	type JobType
} from '$lib/server/jobs';
import { evaluateAlerts } from '$lib/server/alerts';
import { deliverWebhook, pendingDeliveriesReady } from '$lib/server/webhooks';
import { getSetting } from '$lib/server/settings';
import { newId } from '$lib/server/id';
import { decryptCredentials, type Credentials } from '$lib/server/credentials';
import { headersFor, isExpiredOAuth, tokenAt } from '$lib/server/provider-credentials';
import {
	fetchUpstreamCatalog,
	getProvider,
	UPSTREAM_TIMEOUT_MS
} from '$lib/server/provider-catalog-fetch';
import { allowPrivateUpstreams } from '$lib/server/publish-env';
import { guardedUpstreamFetch } from '$lib/server/ssrf';
import { reconcile } from '$lib/server/billing';

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
 * entrypoint (scripts/workers.mjs) wires SIGTERM/SIGINT to it.
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

/**
 * `usage_aggregation`: rebuild hourly + daily buckets for a window.
 * Payload `{from?, to?}` (ISO strings); default = the last two hours ending now,
 * which is the window the periodic scheduler feeds it.
 */
const usageAggregation: JobHandler = async (dbtx, payload) => {
	const to = payload.to ? new Date(String(payload.to)) : new Date();
	const from = payload.from
		? new Date(String(payload.from))
		: new Date(to.getTime() - 2 * 60 * 60 * 1000);
	await rollupUsage(dbtx, usageHourly, 'hour', from, to);
	await rollupUsage(dbtx, usageDaily, 'day', from, to);
};

/**
 * `billing_aggregation`: recompute the `balance_micro` cache from
 * `credit_ledger` for every account (spec §10: the ledger is the record). One
 * pass per account through billing.ts `reconcile` — the single implementation
 * of "balance = SUM(ledger)" both planes agree on. Idempotent.
 */
const billingAggregation: JobHandler = async (dbtx) => {
	const accounts = await dbtx
		.select({ id: billingAccount.id })
		.from(billingAccount)
		.orderBy(billingAccount.id);
	for (const a of accounts) {
		await reconcile(a.id, dbtx);
	}
};

/**
 * `invoice_generation`: one `invoice` row per billing account for the period
 * (PRD §48). Payload `{periodStart?, periodEnd?, billingAccountId?}`; default =
 * the previous calendar month (UTC). Idempotent via the deterministic number
 * (`INV-<yyyymm>-<account suffix>`, unique) plus an explicit "already issued
 * for this period" check — a redelivery must never double-bill.
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
		const existing = await dbtx
			.select({ id: invoice.id })
			.from(invoice)
			.where(
				and(
					eq(invoice.billingAccountId, account.id),
					eq(invoice.periodStart, periodStart),
					eq(invoice.periodEnd, periodEnd)
				)
			)
			.limit(1);
		if (existing.length > 0) continue;
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
				number: `INV-${yyyymm}-${account.id.slice(-8)}`,
				periodStart,
				periodEnd,
				amountMicro: BigInt(amount),
				currency: account.currency,
				status: 'open',
				issuedAt: new Date()
			})
			.onConflictDoNothing({ target: invoice.number });
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
		// Least-recently-validated first: because a probe stamps `lastUsedAt`,
		// this ordering doubles as the cursor that carries progress across runs.
		.orderBy(sql`${credential.lastUsedAt} asc nulls first`, credential.id)
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
			await dbtx
				.update(credential)
				.set({ status: 'invalid', lastErrorAt: new Date(), updatedAt: new Date() })
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
		await dbtx
			.update(credential)
			.set({
				status,
				lastUsedAt: now,
				lastSuccessAt: status === 'healthy' ? now : undefined,
				lastErrorAt: status === 'healthy' ? undefined : now,
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
 * `data_retention_cleanup`: enforce `system_setting['retention']`
 * (PRD §93–94). Two different defaults on purpose — the PRD keeps REQUEST
 * METADATA always and makes content capture opt-in, while destroying rows must
 * never be a zero-config accident:
 *
 * - `request_content_days` scrubs `request_body`/`response_body` past the
 *   window; `0` (the seeded default) therefore scrubs ALL captured content —
 *   content is only kept while a positive window allows it.
 * - `request_metadata_days` / `system_events_days` / `audit_logs_days` DELETE
 *   rows past the window; `0`/negative keeps them forever (deletion is
 *   opt-in — a zero here must never mean "wipe the ledger").
 *
 * Idempotent: a second run finds nothing older than the same cutoffs.
 */
const dataRetentionCleanup: JobHandler = async (dbtx) => {
	const retention = await getSetting('retention');
	const metadataDays = Number(retention?.request_metadata_days ?? 0);
	const contentDays = Number(retention?.request_content_days ?? 0);
	const eventDays = Number(retention?.system_events_days ?? 0);
	const auditDays = Number(retention?.audit_logs_days ?? 0);
	const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000);

	await dbtx
		.update(requestLog)
		.set({ requestBody: null, responseBody: null })
		.where(
			and(
				sql`(${requestLog.requestBody} is not null or ${requestLog.responseBody} is not null)`,
				lt(requestLog.createdAt, cutoff(contentDays))
			)
		);

	let deletedRequests = 0;
	if (metadataDays > 0) {
		const rows = await dbtx
			.delete(requestLog)
			.where(lt(requestLog.createdAt, cutoff(metadataDays)))
			.returning({ id: requestLog.id });
		deletedRequests = rows.length;
	}
	let deletedEvents = 0;
	if (eventDays > 0) {
		const rows = await dbtx
			.delete(systemEvent)
			.where(lt(systemEvent.createdAt, cutoff(eventDays)))
			.returning({ id: systemEvent.id });
		deletedEvents = rows.length;
	}
	let deletedAudits = 0;
	if (auditDays > 0) {
		const rows = await dbtx
			.delete(auditLog)
			.where(lt(auditLog.createdAt, cutoff(auditDays)))
			.returning({ id: auditLog.id });
		deletedAudits = rows.length;
	}
	if (deletedRequests + deletedEvents + deletedAudits > 0) {
		await dbtx.insert(systemEvent).values({
			id: newId('evt_'),
			type: 'data_retention_cleanup',
			resource: 'system',
			resourceId: null,
			metadata: { deletedRequests, deletedEvents, deletedAudits, metadataDays, contentDays }
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
	statistics_aggregation: statisticsAggregation
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
export function createWorker(options: WorkerOptions = {}): WorkerRuntime {
	const types = options.types ?? (Object.keys(JOB_HANDLERS) as JobType[]);
	const concurrency = Math.max(1, options.concurrency ?? 1);
	const idleSleepMs = options.idleSleepMs ?? 2000;
	const staleAfterMs = options.staleAfterMs ?? 600_000;
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
			while (running) {
				if (Date.now() - sinceSweep > staleAfterMs / 2) {
					sinceSweep = Date.now();
					await requeueStaleJobs(staleAfterMs);
				}
				const claimed = await claimJobs(types, concurrency);
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
