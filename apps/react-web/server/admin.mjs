// Admin console API (auth, RBAC, credentials, providers, billing, audit).
// Read-only GET /api/admin/<section> endpoints. Every route requires
// admin.view plus the section cap from ROUTE_CAPS (mirrors +layout.server.ts
// defense-in-depth + each page's requireCap). Registered from index.mjs via
// registerAdminRoutes(app, ctx); all tables here are local minimal column
// copies so index.mjs needs no changes beyond import + register.
import { uuidv7 as _uuidv7 } from 'uuidv7';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, desc, eq, gte, lt, lte, or, ne, isNull, inArray, notInArray, sql } from 'drizzle-orm';
import {
	MIN_PRIORITY, MAX_PRIORITY, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_BATCH_MODELS, MAX_BULK_TEST, MAX_CHAT_CHARS,
	_parseEnum, _parseInt, _parseBool, _cleanField, _parseSlug, _parseJson, _parseFlags, _parseMicros,
	_usdToMicro, _microToUsd, _microsToInput, _matchKey, _isIpOrCidr, _rowsOf, _num
} from './lib/validate.mjs';

import { _fetchCatalog } from './lib/ssrf.mjs';
import { _isBlockedLiteral, _assertPublic, _encCred, _decCred, _tokenAt, _headersFor } from './lib/platform-ts.mjs';
import { clientIp } from './lib/ip.mjs';
import { _sanitizeAudit, _dropRedacted, _auditView, makeAudit } from './lib/audit.mjs';
import { SECTION_CAPS, _dominates, _canAdminister, _guardUser } from './lib/rbac.mjs';
import { _deriveHealth, _evalSignals, _vkPing, _vkSend } from './lib/format.mjs';
import {
	pgTable,
	text,
	timestamp,
	boolean,
	jsonb,
	integer,
	bigint,
	numeric,
	char
} from 'drizzle-orm/pg-core';

const tz = { withTimezone: true };
const bi = (c) => bigint(c, { mode: 'bigint' });

export const prv = pgTable('provider', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug'),
	description: text('description'),
	type: text('type'),
	status: text('status').notNull().default('active'),
	tier: text('tier').notNull().default('commercial'),
	homepage: text('homepage'),
	documentationUrl: text('documentation_url'),
	enabled: boolean('enabled').notNull().default(true),
	priority: integer('priority').notNull().default(100),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const mdl = pgTable('model', {
	id: text('id').primaryKey(),
	providerId: text('provider_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	family: text('family'),
	developer: text('developer'),
	description: text('description'),
	modality: jsonb('modality').notNull().default({}),
	context: integer('context'),
	maxOutput: integer('max_output'),
	capabilities: jsonb('capabilities').notNull().default({}),
	inputPrice: numeric('input_price', { precision: 18, scale: 6 }).notNull(),
	outputPrice: numeric('output_price', { precision: 18, scale: 6 }).notNull(),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	status: text('status').notNull().default('active')
});
export const conn = pgTable('connection', {
	id: text('id').primaryKey(),
	providerId: text('provider_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	baseUrl: text('base_url').notNull(),
	region: text('region'),
	authType: text('auth_type').notNull().default('bearer'),
	timeoutMs: integer('timeout_ms').notNull().default(120000),
	priority: integer('priority').notNull().default(100),
	enabled: boolean('enabled').notNull().default(true),
	healthStatus: text('health_status').notNull().default('unknown')
});
export const cred = pgTable('credential', {
	id: text('id').primaryKey(),
	connectionId: text('connection_id').notNull(),
	name: text('name').notNull(),
	status: text('status').notNull().default('unknown'),
	priority: integer('priority').notNull().default(100)
});
export const prvMdl = pgTable('provider_model', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	providerId: text('provider_id').notNull()
});
export const priceRule = pgTable('pricing_rule', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	providerModelId: text('provider_model_id'),
	version: integer('version').notNull().default(1),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	inputPrice: numeric('input_price', { precision: 18, scale: 6 }).notNull(),
	outputPrice: numeric('output_price', { precision: 18, scale: 6 }).notNull(),
	effectiveUntil: timestamp('effective_until', tz)
});
export const rl = pgTable('request_log', {
	id: text('id').primaryKey(),
	userId: text('user_id'),
	apiKeyId: text('api_key_id'),
	modelId: text('model_id'),
	providerId: text('provider_id'),
	tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
	tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
	cost: bi('cost').notNull().default(sql`0`),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	latencyMs: integer('latency_ms').notNull().default(0),
	ttftMs: integer('ttft_ms'),
	status: text('status').notNull(),
	createdAt: timestamp('created_at', tz).notNull().defaultNow(),
	workspaceId: text('workspace_id'),
	projectId: text('project_id'),
	endpoint: text('endpoint'),
	requestedModel: text('requested_model'),
	connectionId: text('connection_id'),
	strategy: text('strategy'),
	errorCode: text('error_code'),
	httpStatus: integer('http_status'),
	attempts: integer('attempts').notNull().default(1),
	fallbackUsed: boolean('fallback_used').notNull().default(false)
});
export const useDay = pgTable('usage_daily', {
	bucketStart: timestamp('bucket_start', tz).notNull(),
	modelId: text('model_id'),
	providerId: text('provider_id'),
	requests: bigint('requests', { mode: 'number' }).notNull().default(0),
	successes: bigint('successes', { mode: 'number' }).notNull().default(0),
	tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
	tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
	costMicro: bi('cost_micro').notNull().default(sql`0`)
});
export const ws = pgTable('workspace', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	ownerUserId: text('owner_user_id'),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const wsMem = pgTable('workspace_member', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull(),
	userId: text('user_id').notNull()
});
export const proj = pgTable('project', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const env = pgTable('environment', {
	id: text('id').primaryKey(),
	projectId: text('project_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	type: text('type').notNull(),
	status: text('status').notNull().default('active'),
	routingPolicyId: text('routing_policy_id')
});
export const bac = pgTable('billing_account', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull(),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	status: text('status').notNull().default('active'),
	warningThresholdMicro: bi('warning_threshold_micro').notNull().default(sql`10000000`),
	hardStopThresholdMicro: bi('hard_stop_threshold_micro').notNull().default(sql`0`),
	balanceMicro: bi('balance_micro').notNull().default(sql`0`),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const ledger = pgTable('credit_ledger', {
	id: text('id').primaryKey(),
	billingAccountId: text('billing_account_id').notNull(),
	type: text('type').notNull(),
	amountMicro: bi('amount_micro').notNull(),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	requestId: text('request_id'),
	description: text('description'),
	createdBy: text('created_by'),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const inv = pgTable('invoice', {
	id: text('id').primaryKey(),
	billingAccountId: text('billing_account_id').notNull(),
	number: text('number').notNull(),
	periodStart: timestamp('period_start', tz).notNull(),
	periodEnd: timestamp('period_end', tz).notNull(),
	amountMicro: bi('amount_micro').notNull().default(sql`0`),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	status: text('status').notNull().default('draft'),
	issuedAt: timestamp('issued_at', tz),
	paidAt: timestamp('paid_at', tz),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const rpol = pgTable('routing_policy', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id'),
	projectId: text('project_id'),
	environmentId: text('environment_id'),
	name: text('name').notNull(),
	strategy: text('strategy').notNull().default('balanced'),
	enabled: boolean('enabled').notNull().default(true),
	maxAttempts: integer('max_attempts').notNull().default(2),
	fallbackEnabled: boolean('fallback_enabled').notNull().default(true)
});
export const sysSet = pgTable('system_setting', {
	key: text('key').primaryKey(),
	value: jsonb('value').notNull().default(sql`'null'::jsonb`)
});
export const job = pgTable('job', {
	id: text('id').primaryKey(),
	type: text('type').notNull(),
	status: text('status').notNull().default('pending')
});
export const sysEv = pgTable('system_event', {
	id: text('id').primaryKey(),
	type: text('type').notNull(),
	resource: text('resource'),
	resourceId: text('resource_id'),
	metadata: jsonb('metadata').notNull().default({}),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const inc = pgTable('incident', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	component: text('component').notNull(),
	severity: text('severity').notNull().default('minor'),
	status: text('status').notNull().default('investigating'),
	startedAt: timestamp('started_at', tz).notNull().defaultNow(),
	resolvedAt: timestamp('resolved_at', tz),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const incUpd = pgTable('incident_update', {
	id: text('id').primaryKey(),
	incidentId: text('incident_id').notNull(),
	status: text('status').notNull(),
	message: text('message').notNull().default(''),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});
export const secRule = pgTable('security_rule', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	kind: text('kind').notNull(),
	config: jsonb('config').notNull().default({}),
	enabled: boolean('enabled').notNull().default(true),
	action: text('action').notNull().default('log')
});
export const akey = pgTable('api_key', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	name: text('name').notNull(),
	prefix: text('prefix').notNull(),
	status: text('status').notNull().default('active'),
	limits: jsonb('limits').notNull().default({}),
	lastUsedAt: timestamp('last_used_at', tz),
	revokedAt: timestamp('revoked_at', tz),
	createdAt: timestamp('created_at', tz).notNull().defaultNow(),
	workspaceId: text('workspace_id'),
	projectId: text('project_id'),
	environmentId: text('environment_id')
});
export const ausr = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull(),
	role: text('role'),
	banned: boolean('banned').default(false),
	createdAt: timestamp('created_at', tz).notNull().defaultNow()
});

const B = (v) => (typeof v === 'bigint' ? v.toString() : String(v ?? '0'));
const micros = (v) => String(v ?? '0').split('.')[0];

function parseDayParam(v, fallback) {
	if (!v) return fallback;
	const d = new Date(`${v}T00:00:00.000Z`);
	return Number.isNaN(d.getTime()) ? fallback : d;
}
// ---- parity helpers (mirror $lib/server/admin-vocab, publish, money) ----
const MODEL_STATUSES = ['active', 'deprecated', 'sunset', 'disabled'];
const PROVIDER_STATUSES = ['operational', 'degraded', 'disabled', 'maintenance', 'outage'];
const PROVIDER_TIERS = ['commercial', 'dev'];
const CREDENTIAL_STATUSES = ['healthy', 'rate_limited', 'cooldown', 'auth_failed', 'invalid', 'disabled', 'unknown'];
const CONNECTION_AUTH_TYPES = ['bearer', 'oauth', 'header', 'query'];
const PROVIDER_MODEL_STATUSES = ['available', 'degraded', 'unavailable', 'deprecated', 'disabled'];
const CIRCUIT_TARGETS = ['provider', 'connection', 'model'];
const SIGNAL_KINDS = ['request_spike', 'auth_failures', 'key_rotation', 'ip_distribution', 'budget_anomaly', 'excessive_errors', 'credential_abuse'];
const SIGNAL_ACTIONS = ['log', 'block'];
const SIM_STRATEGIES = ['balanced', 'lowest_cost', 'lowest_latency', 'highest_reliability', 'provider_priority', 'weighted', 'round_robin', 'random', 'smart'];
const STRATEGY_USES = { balanced: 'price · latency · reliability · capacity (equal-ish mix)', lowest_cost: 'estimated cost for the token estimate', lowest_latency: 'observed p95 latency', highest_reliability: 'observed availability', provider_priority: 'provider priority', weighted: 'weights jsonb (price / latency / reliability / capacity)', round_robin: 'rotation slot (simulated order is deterministic)', random: 'shuffle slot (simulated order is deterministic)', smart: 'weights jsonb (price / latency / reliability / capacity)' };
const RETRYABLE_CODES = ['RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'CIRCUIT_OPEN', 'UPSTREAM_ERROR', 'transport'];
const NEVER_RETRY_CODES = ['INVALID_REQUEST', 'UNSUPPORTED_PARAMETER', 'CONTEXT_TOO_LONG', 'MODEL_NOT_FOUND', 'AUTHORIZATION_ERROR', 'CONTENT_REJECTED'];
const PROJECT_STATUSES = ['active', 'archived', 'suspended'];
const WORKSPACE_STATUSES = ['active', 'archived', 'suspended'];
const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'];
const RETRYABLE_JOBS = ['failed', 'cancelled'];
const CANCELLABLE_JOBS = ['pending', 'running'];
const REQUEST_STATUSES = ['success', 'client_error', 'provider_error', 'timeout', 'rate_limited', 'cancelled', 'internal_error', 'error', 'upstream_error'];
const LAST_USED_AGES = ['1', '24', '168', '720'];
const RATE_SCOPES = ['workspace', 'project', 'environment', 'api_key'];
const POLICY_SCOPES = ['platform', 'workspace', 'project', 'environment'];
const KEY_LIFECYCLE_ACTIONS = ['key.rotate', 'api_key.rotate', 'key.create'];
const TIMING_KEYS = ['auth', 'rate_limit', 'routing', 'queue', 'connection', 'generation'];
const VK_NAMESPACES = ['rl', 'conc', 'spend', 'usage', 'health', 'credential', 'circuit', 'model', 'catalog', 'session', 'idem', 'lock', 'metric', 'ver'];
const _IDP = { model: 'mdl_', providerModel: 'pmdl_', pricingRule: 'prc_', provider: 'prv_', connection: 'con_', credential: 'cred_', routingPolicy: 'rte_', rateLimit: 'lim_', securityRule: 'rul_', circuitBreaker: 'cbr_', featureFlag: 'flg_', budget: 'bdg_' };
const _newId = (p) => p + _uuidv7();
const _reach = (modelStatus, providerStatus, allowDev) => {
	if (modelStatus !== 'active') return { served: false, reason: 'unpublished' };
	if (providerStatus === 'active') return { served: true, reason: null };
	if (providerStatus === 'dev' && allowDev) return { served: true, reason: null };
	return { served: false, reason: 'provider-off' };
};
const _allowDev = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.ROUTER_ALLOW_DEV_PROVIDERS ?? '').trim().toLowerCase());
const _allowPrivate = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_PRIVATE_UPSTREAMS ?? '').trim().toLowerCase());

export function registerAdminRoutes(app, ctx) {
	const { needDb, authedUser, requireCap, HttpError } = ctx;
	// Request-scoped client IP so every _audit row records it without threading
	// req through ~70 handler signatures. Set by handler()/poster() below.
	const _ipStore = new AsyncLocalStorage();
// Shared, proxy-aware client IP (lib/ip.mjs) — the old local copy trusted a
	// spoofable X-Forwarded-For, poisoning every audit row's ip.
	const _clientIp = clientIp;

	async function gate(req, section) {
		const userRow = await authedUser(req);
		requireCap(userRow, 'admin.view');
		const extra = SECTION_CAPS[section];
		if (extra && extra !== 'admin.view') requireCap(userRow, extra);
		return userRow;
	}
	function handler(section, fn) {
		return async (req, res) => {
			try {
				const database = needDb(res);
				if (!database) return;
				await gate(req, section);
				const url = new URL(req.originalUrl, 'http://localhost');
				res.json(await _ipStore.run(_clientIp(req), () => fn(database, url)));
			} catch (err) {
				if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
				console.error(`[admin/${section}]`, err);
				return res.status(500).json({ error: `Admin ${section} load failed` });
			}
		};
	}
	const _body = (req) => ((req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {});
	function poster(section, fn) {
		return async (req, res) => {
			try {
				const database = needDb(res);
				if (!database) return;
				const userRow = await gate(req, section);
				res.json(await _ipStore.run(_clientIp(req), () => fn(database, _body(req), userRow, req)));
			} catch (err) {
				if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
				console.error(`[admin/${section}]`, err);
				return res.status(500).json({ error: `Admin ${section} action failed` });
			}
		};
	}
	const _fail = (status, message) => { throw new HttpError(status, message); };
	const _audit = makeAudit(_ipStore);
	const _getSetting = async (database, key) => { const r = _rowsOf(await database.execute(sql`select value from system_setting where key = ${key} limit 1`)); return r[0]?.value ?? null; };
	const _setSetting = async (dbx, key, value, actor) => { await dbx.execute(sql`insert into system_setting (key, value, updated_by, updated_at) values (${key}, ${JSON.stringify(value)}::jsonb, ${actor}, now()) on conflict (key) do update set value = ${JSON.stringify(value)}::jsonb, updated_by = ${actor}, updated_at = now()`); };

	// Overview (admin/+page.server.ts): counts + top consumers + recent.
	app.get('/api/admin/overview', handler('analytics', async (database) => {
		const [[providers], [models], [connections], [keys], [users], [reqAgg]] = await Promise.all([
			database.select({ n: sql`count(*)::int` }).from(prv),
			database.select({ n: sql`count(*)::int` }).from(mdl),
			database.select({ n: sql`count(*)::int` }).from(conn),
			database.select({ n: sql`count(*) filter (where ${akey.status} = 'active')::int` }).from(akey),
			database.select({ n: sql`count(*)::int` }).from(ausr),
			database.select({
				n: sql`count(*)::int`,
				tokens: sql`coalesce(sum(${rl.tokensIn} + ${rl.tokensOut}), 0)::int`,
				costMicro: sql`coalesce(sum(${rl.cost}), 0)::text`
			}).from(rl)
		]);
		const topConsumers = await database
			.select({
				keyId: rl.apiKeyId,
				keyName: sql`coalesce(${akey.name}, '—')`,
				email: sql`coalesce(${ausr.email}, '—')`,
				requests: sql`count(*)::int`,
				costMicro: sql`coalesce(sum(${rl.cost}), 0)::text`
			})
			.from(rl)
			.leftJoin(akey, eq(akey.id, rl.apiKeyId))
			.leftJoin(ausr, eq(ausr.id, rl.userId))
			.groupBy(rl.apiKeyId, akey.name, ausr.email)
			.orderBy(sql`coalesce(sum(${rl.cost}), 0) desc`)
			.limit(8);
		const recent = await database
			.select({ id: rl.id, createdAt: rl.createdAt, requestedModel: rl.requestedModel, latencyMs: rl.latencyMs, status: rl.status })
			.from(rl)
			.orderBy(desc(rl.createdAt))
			.limit(12);
		return {
			counts: { providers: providers.n, models: models.n, connections: connections.n, activeKeys: keys.n, users: users.n, requests: reqAgg.n, tokens: reqAgg.tokens, costMicro: reqAgg.costMicro },
			topConsumers,
			recent
		};
	}));

	// Analytics: rollups with request_log fallback + exact latency percentiles.
	app.get('/api/admin/analytics', handler('analytics', async (database, url) => {
		const to = parseDayParam(url.searchParams.get('to'), new Date());
		const from = parseDayParam(url.searchParams.get('from'), new Date(to.getTime() - 7 * 86_400_000));
		const window = and(gte(rl.createdAt, from), lt(rl.createdAt, to));
		const daily = await database
			.select({
				modelId: useDay.modelId,
				providerId: useDay.providerId,
				requests: sql`coalesce(sum(${useDay.requests}), 0)::int`,
				successes: sql`coalesce(sum(${useDay.successes}), 0)::int`,
				tokensIn: sql`coalesce(sum(${useDay.tokensIn}), 0)::int`,
				tokensOut: sql`coalesce(sum(${useDay.tokensOut}), 0)::int`,
				costMicro: sql`coalesce(sum(${useDay.costMicro}), 0)::text`
			})
			.from(useDay)
			.where(and(gte(useDay.bucketStart, from), lt(useDay.bucketStart, to)))
			.groupBy(useDay.modelId, useDay.providerId);
		const usingRollups = daily.length > 0;
		const rows = usingRollups ? daily : await database
			.select({
				modelId: rl.modelId,
				providerId: rl.providerId,
				requests: sql`count(*)::int`,
				successes: sql`count(*) filter (where ${rl.status} = 'success')::int`,
				tokensIn: sql`coalesce(sum(${rl.tokensIn}), 0)::int`,
				tokensOut: sql`coalesce(sum(${rl.tokensOut}), 0)::int`,
				costMicro: sql`coalesce(sum(${rl.cost}), 0)::text`
			})
			.from(rl)
			.where(window)
			.groupBy(rl.modelId, rl.providerId);
		const pct = (p) => sql`coalesce(percentile_cont(${sql.raw(String(p))}) within group (order by ${rl.latencyMs}), 0)::int`;
		const latM = await database.select({ modelId: rl.modelId, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }).from(rl).where(window).groupBy(rl.modelId);
		const latP = await database.select({ providerId: rl.providerId, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }).from(rl).where(window).groupBy(rl.providerId);
		const models = await database.select({ id: mdl.id, slug: mdl.slug }).from(mdl);
		const providers = await database.select({ id: prv.id, name: prv.name }).from(prv);
		const mName = new Map(models.map((m) => [m.id, m.slug]));
		const pName = new Map(providers.map((p) => [p.id, p.name]));
		const latModel = new Map(latM.filter((l) => l.modelId).map((l) => [l.modelId, l]));
		const latProv = new Map(latP.filter((l) => l.providerId).map((l) => [l.providerId, l]));
		const byModel = new Map();
		const byProvider = new Map();
		const bump = (map, key, name, r) => {
			const cur = map.get(key) ?? { id: key, name, requests: 0, successes: 0, tokensIn: 0, tokensOut: 0, costMicro: '0' };
			cur.requests += r.requests; cur.successes += r.successes;
			cur.tokensIn += r.tokensIn; cur.tokensOut += r.tokensOut;
			cur.costMicro = (BigInt(cur.costMicro) + BigInt(r.costMicro)).toString();
			map.set(key, cur);
		};
		for (const r of rows) {
			if (r.modelId) bump(byModel, r.modelId, mName.get(r.modelId) ?? r.modelId, r);
			if (r.providerId) bump(byProvider, r.providerId, pName.get(r.providerId) ?? r.providerId, r);
		}
		const attach = (list, lat) => list.map((r) => ({ ...r, p50: lat.get(r.id)?.p50 ?? 0, p95: lat.get(r.id)?.p95 ?? 0, p99: lat.get(r.id)?.p99 ?? 0 }));
		return {
			from: from.toISOString().slice(0, 10),
			to: to.toISOString().slice(0, 10),
			usingRollups,
			byModel: attach([...byModel.values()].sort((a, b) => b.requests - a.requests), latModel),
			byProvider: attach([...byProvider.values()].sort((a, b) => b.requests - a.requests), latProv)
		};
	}));

	// Billing: accounts + ledger sums + totals + recent + invoices.
	app.get('/api/admin/billing', handler('billing', async (database) => {
		const accounts = await database
			.select({ id: bac.id, workspaceId: bac.workspaceId, workspaceName: ws.name, currency: bac.currency, status: bac.status, warningThresholdMicro: bac.warningThresholdMicro, hardStopThresholdMicro: bac.hardStopThresholdMicro, balanceMicro: bac.balanceMicro })
			.from(bac)
			.innerJoin(ws, eq(ws.id, bac.workspaceId))
			.orderBy(ws.name);
		const sums = await database.select({ billingAccountId: ledger.billingAccountId, total: sql`coalesce(sum(${ledger.amountMicro}), 0)::text` }).from(ledger).groupBy(ledger.billingAccountId);
		const sumBy = new Map(sums.map((s) => [s.billingAccountId, s.total]));
		const totals = await database.select({ type: ledger.type, total: sql`coalesce(sum(${ledger.amountMicro}), 0)::text` }).from(ledger).groupBy(ledger.type).orderBy(ledger.type);
		const recent = await database
			.select({ id: ledger.id, billingAccountId: ledger.billingAccountId, type: ledger.type, amountMicro: ledger.amountMicro, currency: ledger.currency, requestId: ledger.requestId, description: ledger.description, createdBy: ledger.createdBy, createdAt: ledger.createdAt })
			.from(ledger)
			.orderBy(desc(ledger.createdAt), desc(ledger.id))
			.limit(100);
		const invoices = await database
			.select({ id: inv.id, billingAccountId: inv.billingAccountId, number: inv.number, periodStart: inv.periodStart, periodEnd: inv.periodEnd, amountMicro: inv.amountMicro, currency: inv.currency, status: inv.status, issuedAt: inv.issuedAt, paidAt: inv.paidAt })
			.from(inv)
			.orderBy(desc(inv.createdAt), desc(inv.id))
			.limit(100);
		const info = new Map(accounts.map((a) => [a.id, { workspaceName: a.workspaceName, currency: String(a.currency).trim() }]));
		return {
			accounts: accounts.map((a) => ({ id: a.id, workspaceName: a.workspaceName, currency: String(a.currency).trim(), status: a.status, warningThresholdMicro: B(a.warningThresholdMicro), hardStopThresholdMicro: B(a.hardStopThresholdMicro), balanceMicro: B(a.balanceMicro), ledgerSumMicro: sumBy.get(a.id) ?? '0' })),
			totals: totals.map((t) => ({ type: t.type, totalMicro: t.total })),
			recent: recent.map((r) => ({ id: r.id, workspaceName: info.get(r.billingAccountId)?.workspaceName ?? '—', type: r.type, amountMicro: B(r.amountMicro), currency: String(r.currency).trim(), requestId: r.requestId, description: r.description, createdBy: r.createdBy, createdAt: r.createdAt })),
			invoices: invoices.map((v) => ({ id: v.id, workspaceName: info.get(v.billingAccountId)?.workspaceName ?? '—', number: v.number, periodStart: v.periodStart, periodEnd: v.periodEnd, amountMicro: B(v.amountMicro), currency: String(v.currency).trim(), status: v.status, issuedAt: v.issuedAt, paidAt: v.paidAt }))
		};
	}));

	// Connections: routing shape + credential counts (never secrets).
	app.get('/api/admin/connections', handler('connections', async (database) => {
		const rows = await database
			.select({ id: conn.id, name: conn.name, slug: conn.slug, baseUrl: conn.baseUrl, region: conn.region, authType: conn.authType, timeoutMs: conn.timeoutMs, priority: conn.priority, enabled: conn.enabled, healthStatus: conn.healthStatus, providerId: prv.id, providerName: prv.name })
			.from(conn)
			.innerJoin(prv, eq(prv.id, conn.providerId))
			.orderBy(prv.name, conn.priority, conn.name);
		const counts = await database
			.select({ connectionId: cred.connectionId, total: sql`count(*)::int`, healthy: sql`count(*) filter (where ${cred.status} = 'healthy')::int` })
			.from(cred)
			.groupBy(cred.connectionId);
		const byConn = new Map(counts.map((c) => [c.connectionId, c]));
		return { connections: rows.map((r) => ({ ...r, credentialTotal: byConn.get(r.id)?.total ?? 0, credentialHealthy: byConn.get(r.id)?.healthy ?? 0 })) };
	}));

	// Health: observed 24h outcomes per provider/connection + stored state.
	app.get('/api/admin/health', handler('health', async (database) => {
		const last24h = gte(rl.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000));
		const p95 = sql`coalesce(percentile_cont(0.95) within group (order by ${rl.latencyMs}), 0)::int`;
		const byProvider = await database.select({ providerId: rl.providerId, requests: sql`count(*)::int`, successes: sql`count(*) filter (where ${rl.status} = 'success')::int`, p95 }).from(rl).where(last24h).groupBy(rl.providerId);
		const byConnection = await database.select({ connectionId: rl.connectionId, requests: sql`count(*)::int`, successes: sql`count(*) filter (where ${rl.status} = 'success')::int`, p95 }).from(rl).where(and(last24h, sql`${rl.connectionId} is not null`)).groupBy(rl.connectionId);
		const errors = await database
			.select({ providerId: rl.providerId, connectionId: rl.connectionId, code: sql`coalesce(${rl.errorCode}, ${rl.status})`, n: sql`count(*)::int` })
			.from(rl)
			.where(and(last24h, sql`${rl.status} != 'success'`))
			.groupBy(rl.providerId, rl.connectionId, sql`coalesce(${rl.errorCode}, ${rl.status})`);
		const providers = await database.select({ id: prv.id, name: prv.name, status: prv.status }).from(prv).orderBy(prv.name);
		const connections = await database.select({ id: conn.id, providerId: conn.providerId, name: conn.name, region: conn.region, enabled: conn.enabled, healthStatus: conn.healthStatus }).from(conn).orderBy(conn.name);
		const creds = await database.select({ connectionId: cred.connectionId, total: sql`count(*)::int`, healthy: sql`count(*) filter (where ${cred.status} = 'healthy')::int` }).from(cred).groupBy(cred.connectionId);
		const pStats = new Map(byProvider.map((p) => [p.providerId, p]));
		const cStats = new Map(byConnection.map((c) => [c.connectionId, c]));
		const credBy = new Map(creds.map((c) => [c.connectionId, c]));
		const errP = new Map();
		const errC = new Map();
		for (const e of errors) {
			if (e.providerId) errP.set(e.providerId, [...(errP.get(e.providerId) ?? []), { code: e.code, n: e.n }]);
			if (e.connectionId) errC.set(e.connectionId, [...(errC.get(e.connectionId) ?? []), { code: e.code, n: e.n }]);
		}
		return {
			providers: providers.map((p) => ({ ...p, requests: pStats.get(p.id)?.requests ?? 0, successes: pStats.get(p.id)?.successes ?? 0, p95: pStats.get(p.id)?.p95 ?? 0, errorMix: (errP.get(p.id) ?? []).sort((a, b) => b.n - a.n) })),
			connections: connections.map((c) => ({ ...c, requests: cStats.get(c.id)?.requests ?? 0, successes: cStats.get(c.id)?.successes ?? 0, p95: cStats.get(c.id)?.p95 ?? 0, errorMix: (errC.get(c.id) ?? []).sort((a, b) => b.n - a.n), credentialsTotal: credBy.get(c.id)?.total ?? 0, credentialsHealthy: credBy.get(c.id)?.healthy ?? 0 }))
		};
	}));

	// Incidents + timeline updates.
	app.get('/api/admin/incidents', handler('incidents', async (database) => {
		const rows = await database
			.select({ id: inc.id, title: inc.title, component: inc.component, severity: inc.severity, status: inc.status, startedAt: inc.startedAt, resolvedAt: inc.resolvedAt, createdAt: inc.createdAt })
			.from(inc)
			.orderBy(desc(inc.startedAt));
		const updates = await database
			.select({ id: incUpd.id, incidentId: incUpd.incidentId, status: incUpd.status, message: incUpd.message, createdAt: incUpd.createdAt })
			.from(incUpd)
			.orderBy(desc(incUpd.createdAt));
		const byInc = new Map();
		for (const u of updates) byInc.set(u.incidentId, [...(byInc.get(u.incidentId) ?? []), u]);
		return { incidents: rows.map((r) => ({ ...r, updates: byInc.get(r.id) ?? [] })) };
	}));

	// Keys: metadata only (never key_hash) + per-key usage.
	app.get('/api/admin/keys', handler('keys', async (database) => {
		const users = await database.select({ id: ausr.id, email: ausr.email, name: ausr.name, role: ausr.role }).from(ausr).orderBy(ausr.email);
		const keys = await database
			.select({ id: akey.id, name: akey.name, prefix: akey.prefix, status: akey.status, limits: akey.limits, lastUsedAt: akey.lastUsedAt, revokedAt: akey.revokedAt, createdAt: akey.createdAt, userId: akey.userId, email: ausr.email, workspaceName: ws.name, projectName: proj.name, environmentName: env.name })
			.from(akey)
			.innerJoin(ausr, eq(ausr.id, akey.userId))
			.leftJoin(ws, eq(ws.id, akey.workspaceId))
			.leftJoin(proj, eq(proj.id, akey.projectId))
			.leftJoin(env, eq(env.id, akey.environmentId))
			.orderBy(desc(akey.createdAt));
		const usage = await database
			.select({ apiKeyId: rl.apiKeyId, requests: sql`count(*)::int`, tokensIn: sql`coalesce(sum(${rl.tokensIn}), 0)::int`, tokensOut: sql`coalesce(sum(${rl.tokensOut}), 0)::int`, cost: sql`coalesce(sum(${rl.cost}), 0)::text` })
			.from(rl)
			.groupBy(rl.apiKeyId);
		const byKey = new Map(usage.map((u) => [u.apiKeyId, u]));
		const empty = { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' };
		const rows = keys.map((k) => {
			const limits = k.limits ?? {};
			return { ...k, usage: byKey.get(k.id) ?? empty, rpm: limits.rpm ?? null, monthlyCapMicro: limits.monthly_cost_micro ?? null };
		}).sort((a, b) => Number(BigInt(b.usage.cost) - BigInt(a.usage.cost)));
		return { users, keys: rows };
	}));

	// Models: catalog + mapping counts + effective price + per-provider summary.
	app.get('/api/admin/models', handler('models', async (database, url) => {
		const providers = await database.select({ id: prv.id, name: prv.name, status: prv.status }).from(prv).orderBy(asc(prv.name));
		const models = await database
			.select({ id: mdl.id, providerId: mdl.providerId, name: mdl.name, slug: mdl.slug, family: mdl.family, developer: mdl.developer, description: mdl.description, modality: mdl.modality, context: mdl.context, maxOutput: mdl.maxOutput, capabilities: mdl.capabilities, inputPrice: mdl.inputPrice, outputPrice: mdl.outputPrice, currency: mdl.currency, status: mdl.status })
			.from(mdl)
			.orderBy(asc(mdl.slug));
		const mappingCounts = await database.select({ modelId: prvMdl.modelId, n: sql`count(*)::int` }).from(prvMdl).groupBy(prvMdl.modelId);
		const mappingsOf = new Map(mappingCounts.map((c) => [c.modelId, c.n]));
		const openWide = await database
			.select({ modelId: priceRule.modelId, version: priceRule.version, currency: priceRule.currency, inputPrice: priceRule.inputPrice, outputPrice: priceRule.outputPrice })
			.from(priceRule)
			.where(and(isNull(priceRule.effectiveUntil), isNull(priceRule.providerModelId)))
			.orderBy(desc(priceRule.version));
		const effectiveOf = new Map(openWide.map((r) => [r.modelId, r]));
		const providerOf = new Map(providers.map((p) => [p.id, p]));
		const allowDev = _allowDev();
		const rows = models.map((m) => {
			const parent = providerOf.get(m.providerId);
			const rule = effectiveOf.get(m.id);
			const reach = _reach(m.status, parent?.status ?? 'disabled', allowDev);
			return {
				id: m.id, providerId: m.providerId, name: m.name, slug: m.slug, family: m.family,
				developer: m.developer, description: m.description, modality: m.modality, context: m.context,
				maxOutput: m.maxOutput, capabilities: m.capabilities, status: m.status,
				currency: rule?.currency ?? m.currency,
				inputPriceMicro: micros(rule ? rule.inputPrice : m.inputPrice),
				outputPriceMicro: micros(rule ? rule.outputPrice : m.outputPrice),
				mappingCount: mappingsOf.get(m.id) ?? 0,
				providerName: parent?.name ?? '—',
				providerStatus: parent?.status ?? '—',
				served: reach.served,
				hiddenReason: reach.reason
			};
		});
		const summary = providers.map((p) => {
			const mine = rows.filter((r) => r.providerId === p.id);
			return { id: p.id, name: p.name, status: p.status, total: mine.length, published: mine.filter((r) => r.status === 'active').length, served: mine.filter((r) => r.served).length };
		});
		const providerFilter = url.searchParams.get('provider') ?? '';
		const stateFilter = url.searchParams.get('state') ?? 'all';
		const visible = rows.filter((r) => {
			if (providerFilter && r.providerId !== providerFilter) return false;
			if (stateFilter === 'served') return r.served;
			if (stateFilter === 'hidden') return !r.served;
			return true;
		});
		return { providers, models: visible, summary, providerFilter, stateFilter, allowDev, statuses: MODEL_STATUSES, counts: { all: rows.length, served: rows.filter((r) => r.served).length, hidden: rows.filter((r) => !r.served).length, published: rows.filter((r) => r.status === 'active').length } };
	}));

	// Projects + usage/env/key counts.
	app.get('/api/admin/projects', handler('projects', async (database) => {
		const rows = await database
			.select({ id: proj.id, name: proj.name, slug: proj.slug, status: proj.status, workspaceName: ws.name, createdAt: proj.createdAt })
			.from(proj)
			.innerJoin(ws, eq(ws.id, proj.workspaceId))
			.orderBy(ws.name, proj.name);
		const projIds = rows.map((r) => r.id);
		const usageBy = new Map(projIds.map((id) => [id, { requests: 0, cost: '0' }]));
		const envBy = new Map(projIds.map((id) => [id, 0]));
		const keyBy = new Map(projIds.map((id) => [id, 0]));
		if (projIds.length > 0) {
			const usage = await database.select({ projectId: rl.projectId, requests: sql`count(*)::int`, cost: sql`coalesce(sum(${rl.cost}), 0)::text` }).from(rl).where(inArray(rl.projectId, projIds)).groupBy(rl.projectId);
			for (const u of usage) if (u.projectId) usageBy.set(u.projectId, { requests: u.requests, cost: u.cost });
			const envs = await database.select({ projectId: env.projectId, n: sql`count(*)::int` }).from(env).where(inArray(env.projectId, projIds)).groupBy(env.projectId);
			for (const e of envs) envBy.set(e.projectId, e.n);
			const keys = await database.select({ projectId: akey.projectId, n: sql`count(*)::int` }).from(akey).where(inArray(akey.projectId, projIds)).groupBy(akey.projectId);
			for (const k of keys) if (k.projectId) keyBy.set(k.projectId, k.n);
		}
		return { projects: rows.map((r) => ({ ...r, environments: envBy.get(r.id) ?? 0, keys: keyBy.get(r.id) ?? 0, requests: usageBy.get(r.id)?.requests ?? 0, cost: usageBy.get(r.id)?.cost ?? '0' })) };
	}));

	// Providers: metadata + model/connection counts + credential health.
	app.get('/api/admin/providers', handler('providers', async (database) => {
		const rows = await database
			.select({ id: prv.id, name: prv.name, slug: prv.slug, description: prv.description, type: prv.type, status: prv.status, tier: prv.tier, homepage: prv.homepage, documentationUrl: prv.documentationUrl, enabled: prv.enabled, priority: prv.priority, createdAt: prv.createdAt })
			.from(prv)
			.orderBy(prv.priority, prv.name);
		const modelCounts = await database.select({ providerId: mdl.providerId, n: sql`count(*)::int` }).from(mdl).groupBy(mdl.providerId);
		const byM = new Map(modelCounts.map((c) => [c.providerId, c.n]));
		const connCounts = await database.select({ providerId: conn.providerId, n: sql`count(*)::int` }).from(conn).groupBy(conn.providerId);
		const byC = new Map(connCounts.map((c) => [c.providerId, c.n]));
		const credHealth = await database
			.select({
				providerId: conn.providerId,
				total: sql`count(*)::int`,
				healthy: sql`count(*) filter (where ${cred.status} = 'healthy')::int`,
				unknown: sql`count(*) filter (where ${cred.status} = 'unknown')::int`,
				bad: sql`count(*) filter (where ${cred.status} in ('auth_failed', 'invalid'))::int`
			})
			.from(cred)
			.innerJoin(conn, eq(conn.id, cred.connectionId))
			.groupBy(conn.providerId);
		const byH = new Map(credHealth.map((c) => [c.providerId, c]));
		const models = await database.select({ id: mdl.id, providerId: mdl.providerId, slug: mdl.slug, status: mdl.status }).from(mdl).orderBy(mdl.slug);
		return {
			providers: rows.map((r) => ({
				...r,
				modelCount: byM.get(r.id) ?? 0,
				connectionCount: byC.get(r.id) ?? 0,
				credentials: { total: byH.get(r.id)?.total ?? 0, healthy: byH.get(r.id)?.healthy ?? 0, unknown: byH.get(r.id)?.unknown ?? 0, bad: byH.get(r.id)?.bad ?? 0 }
			})),
			models,
			statuses: PROVIDER_STATUSES,
			tiers: PROVIDER_TIERS
		};
	}));

	// Requests: read-only list, no bodies (limit 200, query filters).
	app.get('/api/admin/requests', handler('requests', async (database, url) => {
		const q = (k) => (url.searchParams.get(k) ?? '').trim().slice(0, 200);
		const status = q('status'), errorCode = q('error_code'), modelFilter = q('model'), providerFilter = q('provider');
		const parseDay = (raw, end) => {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
			const d = new Date(`${raw}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
			return Number.isNaN(d.getTime()) ? null : d;
		};
		const from = parseDay(q('from'), false), to = parseDay(q('to'), true);
		const conds = [];
		if (status) conds.push(eq(rl.status, status));
		if (errorCode) conds.push(eq(rl.errorCode, errorCode));
		if (modelFilter) conds.push(or(eq(rl.requestedModel, modelFilter), eq(mdl.slug, modelFilter)));
		if (providerFilter) conds.push(eq(rl.providerId, providerFilter));
		if (from) conds.push(gte(rl.createdAt, from));
		if (to) conds.push(lte(rl.createdAt, to));
		const rows = await database
			.select({ id: rl.id, createdAt: rl.createdAt, email: ausr.email, keyName: akey.name, requestedModel: rl.requestedModel, modelSlug: mdl.slug, providerName: prv.name, connectionName: conn.name, strategy: rl.strategy, attempts: rl.attempts, fallbackUsed: rl.fallbackUsed, ttftMs: rl.ttftMs, latencyMs: rl.latencyMs, status: rl.status, errorCode: rl.errorCode, httpStatus: rl.httpStatus, tokensIn: rl.tokensIn, tokensOut: rl.tokensOut, cost: rl.cost, currency: rl.currency })
			.from(rl)
			.leftJoin(ausr, eq(ausr.id, rl.userId))
			.leftJoin(akey, eq(akey.id, rl.apiKeyId))
			.leftJoin(mdl, eq(mdl.id, rl.modelId))
			.leftJoin(prv, eq(prv.id, rl.providerId))
			.leftJoin(conn, eq(conn.id, rl.connectionId))
			.where(conds.length > 0 ? and(...conds) : undefined)
			.orderBy(desc(rl.createdAt))
			.limit(200);
		const providers = await database.select({ id: prv.id, name: prv.name }).from(prv).orderBy(prv.name);
		return { rows: rows.map((r) => ({ ...r, cost: B(r.cost) })), providers, statuses: REQUEST_STATUSES, filters: { status, errorCode, model: modelFilter, provider: providerFilter, from: q('from'), to: q('to') } };
	}));

	// Routing: policies + resolution chain + platform default.
	app.get('/api/admin/routing', handler('routing', async (database) => {
		const policies = await database
			.select({ id: rpol.id, name: rpol.name, strategy: rpol.strategy, enabled: rpol.enabled, maxAttempts: rpol.maxAttempts, fallbackEnabled: rpol.fallbackEnabled, workspaceId: rpol.workspaceId, projectId: rpol.projectId, environmentId: rpol.environmentId })
			.from(rpol)
			.orderBy(rpol.name);
		const [workspaces, projects, envs, defRow] = await Promise.all([
			database.select({ id: ws.id, name: ws.name }).from(ws).orderBy(ws.name),
			database.select({ id: proj.id, name: proj.name, workspaceId: proj.workspaceId }).from(proj).orderBy(proj.name),
			database.select({ id: env.id, name: env.name, projectId: env.projectId, routingPolicyId: env.routingPolicyId }).from(env).orderBy(env.name),
			database.select({ value: sysSet.value }).from(sysSet).where(eq(sysSet.key, 'default_routing_policy')).limit(1)
		]);
		const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
		const projById = new Map(projects.map((p) => [p.id, p]));
		const envName = new Map(envs.map((e) => [e.id, e.name]));
		const policyById = new Map(policies.map((p) => [p.id, p]));
		const scoped = policies.map((p) => {
			const scope = p.environmentId ? 'environment' : p.projectId ? 'project' : p.workspaceId ? 'workspace' : 'platform';
			let scopeName = 'platform';
			if (p.environmentId && envName.has(p.environmentId)) {
				const e = envs.find((x) => x.id === p.environmentId);
				scopeName = `environment: ${envName.get(p.environmentId)} (${e ? (projById.get(e.projectId)?.name ?? e.projectId) : ''})`;
			} else if (p.projectId && projById.has(p.projectId)) scopeName = `project: ${projById.get(p.projectId)?.name}`;
			else if (p.workspaceId && wsName.has(p.workspaceId)) scopeName = `workspace: ${wsName.get(p.workspaceId)}`;
			return { ...p, scope, scopeName };
		});
		const chain = envs.map((e) => {
			const pr = projById.get(e.projectId);
			return { environment: e.name, project: pr?.name ?? e.projectId, workspace: pr ? (wsName.get(pr.workspaceId) ?? pr.workspaceId) : '—', policyId: e.routingPolicyId, policyName: e.routingPolicyId ? (policyById.get(e.routingPolicyId)?.name ?? null) : null };
		});
		const platformDefaultId = defRow[0]?.value?.id ?? null;
		return { policies: scoped, chain, platformDefaultId, platformDefaultName: platformDefaultId ? (policyById.get(platformDefaultId)?.name ?? platformDefaultId) : null };
	}));

	// Security: signal rules only (enforcement lists live on their own pages).
	app.get('/api/admin/security', handler('security', async (database) => {
		const rows = await database
			.select({ id: secRule.id, name: secRule.name, kind: secRule.kind, config: secRule.config, enabled: secRule.enabled, action: secRule.action })
			.from(secRule)
			.where(notInArray(secRule.kind, ['blocked_ip', 'blocked_key']))
			.orderBy(secRule.name);
		return { rules: rows, kinds: SIGNAL_KINDS, actions: SIGNAL_ACTIONS };
	}));

	// Settings: platform settings + policies + billing thresholds.
	app.get('/api/admin/settings', handler('settings', async (database) => {
		const keys = ['maintenance', 'generic_passthrough', 'registration', 'retention', 'default_routing_policy', 'platform_hard_limits'];
		const srows = await database.select({ key: sysSet.key, value: sysSet.value }).from(sysSet).where(inArray(sysSet.key, keys));
		const got = (k) => srows.find((r) => r.key === k)?.value ?? null;
		const maintenance = got('maintenance'), passthrough = got('generic_passthrough'), registration = got('registration');
		const retention = got('retention'), defaultRouting = got('default_routing_policy'), hardLimits = got('platform_hard_limits');
		const policies = await database.select({ id: rpol.id, name: rpol.name, strategy: rpol.strategy }).from(rpol).orderBy(rpol.name);
		const accounts = await database.select({ workspaceId: bac.workspaceId, warningThresholdMicro: bac.warningThresholdMicro, hardStopThresholdMicro: bac.hardStopThresholdMicro }).from(bac).orderBy(bac.createdAt);
		return {
			maintenance: maintenance?.enabled ?? false,
			genericPassthrough: passthrough?.enabled ?? false,
			registration: registration?.enabled ?? false,
			retention: { request_metadata_days: retention?.request_metadata_days ?? 90, request_content_days: retention?.request_content_days ?? 0, system_events_days: retention?.system_events_days ?? 90, audit_logs_days: retention?.audit_logs_days ?? 365 },
			defaultRoutingPolicyId: defaultRouting?.id ?? '',
			hardLimits: { rpm: hardLimits?.rpm ?? 10000, tpm: hardLimits?.tpm ?? 100000000, concurrency: hardLimits?.concurrency ?? 1000 },
			policies,
			accounts: accounts.map((a) => ({ workspaceId: a.workspaceId, warningMicro: B(a.warningThresholdMicro), hardStopMicro: B(a.hardStopThresholdMicro) }))
		};
	}));

	// System: db stats (soft-fail) + job backlog + open incidents + events.
	app.get('/api/admin/system', handler('system', async (database) => {
		let dbStats = null;
		try {
			const rows = await database.execute(sql`select pg_size_pretty(pg_database_size(current_database())) as size, (select count(*)::int from pg_stat_activity) as connections`);
			const row = rows[0] ?? rows.rows?.[0];
			if (row) dbStats = { size: String(row.size), connections: Number(row.connections) };
		} catch { dbStats = null; }
		const jobCounts = await database.select({ status: job.status, n: sql`count(*)::int` }).from(job).groupBy(job.status);
		const backlog = jobCounts.reduce((s, j) => (j.status === 'pending' || j.status === 'running' ? s + j.n : s), 0);
		const openIncidents = await database
			.select({ id: inc.id, title: inc.title, component: inc.component, severity: inc.severity, status: inc.status, startedAt: inc.startedAt })
			.from(inc)
			.where(ne(inc.status, 'resolved'))
			.orderBy(desc(inc.startedAt));
		const events = await database
			.select({ id: sysEv.id, type: sysEv.type, resource: sysEv.resource, resourceId: sysEv.resourceId, metadata: sysEv.metadata, createdAt: sysEv.createdAt })
			.from(sysEv)
			.orderBy(desc(sysEv.createdAt))
			.limit(20);
		return { database: dbStats, valkey: await _vkPing(), backlog, jobCounts, openIncidents, events };
	}));

	// Traffic: platform hard limits.
	app.get('/api/admin/traffic', handler('traffic', async (database) => {
		const [row] = await database.select({ value: sysSet.value }).from(sysSet).where(eq(sysSet.key, 'platform_hard_limits')).limit(1);
		return { hard: row?.value ?? null };
	}));

	// Users + usage/workspace/project/key counts + last activity.
	app.get('/api/admin/users', handler('users', async (database) => {
		const users = await database
			.select({ id: ausr.id, name: ausr.name, email: ausr.email, role: ausr.role, banned: ausr.banned, createdAt: ausr.createdAt })
			.from(ausr)
			.orderBy(desc(ausr.createdAt));
		const userIds = users.map((u) => u.id);
		const usageBy = new Map(userIds.map((id) => [id, { requests: 0, cost: '0', lastRequest: null }]));
		const wsBy = new Map(userIds.map((id) => [id, 0]));
		const projBy = new Map(userIds.map((id) => [id, 0]));
		const keyBy = new Map(userIds.map((id) => [id, 0]));
		const lastBy = new Map(userIds.map((id) => [id, null]));
		if (userIds.length > 0) {
			const usage = await database.select({ userId: rl.userId, requests: sql`count(*)::int`, cost: sql`coalesce(sum(${rl.cost}), 0)::text`, lastRequest: sql`max(${rl.createdAt})` }).from(rl).where(inArray(rl.userId, userIds)).groupBy(rl.userId);
			for (const u of usage) if (u.userId) usageBy.set(u.userId, u);
			const mws = await database.select({ userId: wsMem.userId, n: sql`count(*)::int` }).from(wsMem).where(inArray(wsMem.userId, userIds)).groupBy(wsMem.userId);
			for (const w of mws) wsBy.set(w.userId, w.n);
			const keys = await database.select({ userId: akey.userId, n: sql`count(*)::int` }).from(akey).where(inArray(akey.userId, userIds)).groupBy(akey.userId);
			for (const k of keys) keyBy.set(k.userId, k.n);
			const ku = await database.select({ userId: akey.userId, at: sql`max(${akey.lastUsedAt})` }).from(akey).where(inArray(akey.userId, userIds)).groupBy(akey.userId);
			const keyUse = new Map(ku.map((k) => [k.userId, k.at]));
			try {
				const pc = _rowsOf(await database.execute(sql`select wm.user_id as user_id, count(distinct p.id)::int as n from project p join workspace_member wm on wm.workspace_id = p.workspace_id where wm.user_id in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) group by wm.user_id`));
				for (const r of pc) projBy.set(r.user_id, Number(r.n));
			} catch {}
			let sessUse = new Map(), audUse = new Map();
			try { const s = _rowsOf(await database.execute(sql`select user_id, max(created_at) as at from session where user_id in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) group by user_id`)); sessUse = new Map(s.map((r) => [r.user_id, r.at])); } catch {}
			try { const a = _rowsOf(await database.execute(sql`select actor_user_id as user_id, max(created_at) as at from audit_log where actor_user_id in (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) group by actor_user_id`)); audUse = new Map(a.map((r) => [r.user_id, r.at])); } catch {}
			for (const id of userIds) {
				const ds = [usageBy.get(id)?.lastRequest, keyUse.get(id), sessUse.get(id), audUse.get(id)].filter((d) => d instanceof Date);
				lastBy.set(id, ds.length > 0 ? new Date(Math.max(...ds.map((d) => d.getTime()))) : null);
			}
		}
	}));

	// Workspaces + member/project/request counts + ledger balance.
	app.get('/api/admin/workspaces', handler('workspaces', async (database) => {
		const rows = await database
			.select({ id: ws.id, name: ws.name, slug: ws.slug, status: ws.status, ownerEmail: ausr.email, createdAt: ws.createdAt })
			.from(ws)
			.leftJoin(ausr, eq(ausr.id, ws.ownerUserId))
			.orderBy(ws.name);
		const wsIds = rows.map((r) => r.id);
		const usageBy = new Map(wsIds.map((id) => [id, { requests: 0, cost: '0' }]));
		const memBy = new Map(wsIds.map((id) => [id, 0]));
		const projBy = new Map(wsIds.map((id) => [id, 0]));
		const balBy = new Map(wsIds.map((id) => [id, '0']));
		if (wsIds.length > 0) {
			const usage = await database.select({ workspaceId: rl.workspaceId, requests: sql`count(*)::int`, cost: sql`coalesce(sum(${rl.cost}), 0)::text` }).from(rl).where(inArray(rl.workspaceId, wsIds)).groupBy(rl.workspaceId);
			for (const u of usage) if (u.workspaceId) usageBy.set(u.workspaceId, { requests: u.requests, cost: u.cost });
			const members = await database.select({ workspaceId: wsMem.workspaceId, n: sql`count(*)::int` }).from(wsMem).where(inArray(wsMem.workspaceId, wsIds)).groupBy(wsMem.workspaceId);
			for (const m of members) memBy.set(m.workspaceId, m.n);
			const projs = await database.select({ workspaceId: proj.workspaceId, n: sql`count(*)::int` }).from(proj).where(inArray(proj.workspaceId, wsIds)).groupBy(proj.workspaceId);
			for (const p of projs) projBy.set(p.workspaceId, p.n);
			const accts = await database.select({ workspaceId: bac.workspaceId, id: bac.id }).from(bac).where(inArray(bac.workspaceId, wsIds));
			for (const a of accts) {
				const [s] = await database.select({ total: sql`coalesce(sum(${ledger.amountMicro}), 0)::text` }).from(ledger).where(eq(ledger.billingAccountId, a.id));
				balBy.set(a.workspaceId, s?.total ?? '0');
			}
		}
		return { workspaces: rows.map((r) => ({ ...r, members: memBy.get(r.id) ?? 0, projects: projBy.get(r.id) ?? 0, requests: usageBy.get(r.id)?.requests ?? 0, cost: usageBy.get(r.id)?.cost ?? '0', balanceMicro: balBy.get(r.id) ?? '0' })) };
	}));

// ---- parity block: models ----
	// Model detail (admin/models/[id]): model + mappings + pricing + usage + statuses.
	app.get('/api/admin/models/mappings', handler('models', async (database) => {
		const rows = _rowsOf(await database.execute(sql`select pm.id, pm.model_id, pm.provider_id, pm.connection_id, pm.provider_model_id, pm.enabled, pm.capabilities_override, pm.context_override, pm.status, m.slug as model_slug, p.name as provider_name, c.name as connection_name from provider_model pm join model m on m.id = pm.model_id join provider p on p.id = pm.provider_id left join connection c on c.id = pm.connection_id order by m.slug, p.name`));
		const models = _rowsOf(await database.execute(sql`select id, slug, name from model order by slug`));
		const providers = _rowsOf(await database.execute(sql`select id, name from provider order by name`));
		const connections = _rowsOf(await database.execute(sql`select id, provider_id, name, region from connection order by name`));
		return { rows: rows.map((r) => ({ id: r.id, modelId: r.model_id, providerId: r.provider_id, connectionId: r.connection_id, providerModelId: r.provider_model_id, enabled: r.enabled, capabilitiesOverride: r.capabilities_override, contextOverride: r.context_override, status: r.status, modelSlug: r.model_slug, providerName: r.provider_name, connectionName: r.connection_name })), models, providers, connections, statuses: PROVIDER_MODEL_STATUSES };
	}));
	app.get('/api/admin/models/pricing', handler('models', async (database, url) => {
		const modelFilter = url.searchParams.get('model') ?? '';
		const rows = _rowsOf(await database.execute(sql`select pr.id, pr.model_id, pr.provider_model_id, pr.version, pr.currency, pr.input_price::text as input_price, pr.cached_input_price::text as cached_input_price, pr.output_price::text as output_price, pr.reasoning_price::text as reasoning_price, pr.effective_from, pr.effective_until, pr.created_by, pr.created_at, m.slug as model_slug, pm.provider_model_id as mapping_upstream from pricing_rule pr join model m on m.id = pr.model_id left join provider_model pm on pm.id = pr.provider_model_id order by m.slug, pr.provider_model_id, pr.version desc`));
		const rules = rows.map((r) => ({ id: r.id, modelId: r.model_id, providerModelId: r.provider_model_id, scope: r.provider_model_id ? (r.mapping_upstream ?? '(removed mapping)') : 'model-wide', modelSlug: r.model_slug, version: _num(r.version), currency: String(r.currency).trim(), inputPriceMicro: micros(r.input_price), cachedInputPriceMicro: r.cached_input_price === null ? null : micros(r.cached_input_price), outputPriceMicro: micros(r.output_price), reasoningPriceMicro: r.reasoning_price === null ? null : micros(r.reasoning_price), effectiveFrom: new Date(r.effective_from).toISOString(), effectiveUntil: r.effective_until ? new Date(r.effective_until).toISOString() : null, current: r.effective_until === null, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() }));
		const models = _rowsOf(await database.execute(sql`select id, slug from model order by slug`));
		const mappings = _rowsOf(await database.execute(sql`select id, model_id, provider_model_id as upstream from provider_model order by provider_model_id`));
		return { models, mappings, rules: modelFilter ? rules.filter((r) => r.modelId === modelFilter) : rules, modelFilter };
	}));
	app.get('/api/admin/models/sync', handler('models', async (database) => {
		const providers = _rowsOf(await database.execute(sql`select id, name from provider order by name`));
		return { providers };
	}));
	app.get('/api/admin/models/:id', handler('models', async (database, url, req) => {
		const id = String(url.pathname.split('/').pop());
		const mrows = _rowsOf(await database.execute(sql`select id, provider_id, name, slug, family, developer, description, modality, context, max_output, capabilities, input_price::text as input_price, output_price::text as output_price, currency, status, created_at, updated_at from model where id = ${id} limit 1`));
		if (!mrows.length) { const e = new ctx.HttpError(404, 'Model not found'); throw e; }
		const m = mrows[0];
		const mappings = _rowsOf(await database.execute(sql`select pm.id, pm.provider_id, pm.connection_id, pm.provider_model_id, pm.enabled, pm.capabilities_override, pm.context_override, pm.status, p.name as provider_name, c.name as connection_name from provider_model pm join provider p on p.id = pm.provider_id left join connection c on c.id = pm.connection_id where pm.model_id = ${id} order by p.name, pm.provider_model_id`));
		const mapById = new Map(mappings.map((r) => [r.id, r]));
		const rules = _rowsOf(await database.execute(sql`select id, provider_model_id, version, currency, input_price::text as input_price, cached_input_price::text as cached_input_price, output_price::text as output_price, reasoning_price::text as reasoning_price, effective_from, effective_until, created_by, created_at from pricing_rule where model_id = ${id} order by provider_model_id nulls first, version desc`));
		const pricing = rules.map((r) => {
			const mp = r.provider_model_id ? mapById.get(r.provider_model_id) : null;
			return { id: r.id, scope: r.provider_model_id ? (mp?.provider_model_id ?? '(removed mapping)') : 'model-wide', version: _num(r.version), currency: String(r.currency).trim(), inputPriceMicro: micros(r.input_price), cachedInputPriceMicro: r.cached_input_price === null ? null : micros(r.cached_input_price), outputPriceMicro: micros(r.output_price), reasoningPriceMicro: r.reasoning_price === null ? null : micros(r.reasoning_price), effectiveFrom: new Date(r.effective_from).toISOString(), effectiveUntil: r.effective_until ? new Date(r.effective_until).toISOString() : null, current: r.effective_until === null, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() };
		});
		const tot = _rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost, coalesce(round(avg(latency_ms)),0)::int as avg_latency from request_log where model_id = ${id}`))[0] ?? {};
		const day = _rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(sum(cost),0)::text as cost from request_log where model_id = ${id} and created_at > now() - interval '24 hours'`))[0] ?? {};
		const perDay = _rowsOf(await database.execute(sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(sum(cost),0)::text as cost from request_log where model_id = ${id} and created_at > now() - interval '14 days' group by date_trunc('day', created_at) order by date_trunc('day', created_at) desc`));
		const mi = BigInt(String(m.input_price).split('.')[0]); const mo = BigInt(String(m.output_price).split('.')[0]);
		return { model: { id: m.id, name: m.name, slug: m.slug, family: m.family, developer: m.developer, description: m.description, modality: m.modality, context: m.context, maxOutput: m.max_output, capabilities: m.capabilities, currency: String(m.currency).trim(), status: m.status, inputUsd: _microsToInput(mi), outputUsd: _microsToInput(mo), createdAt: new Date(m.created_at).toISOString(), updatedAt: new Date(m.updated_at).toISOString() }, mappings: mappings.map((r) => ({ id: r.id, providerId: r.provider_id, connectionId: r.connection_id, providerModelId: r.provider_model_id, enabled: r.enabled, capabilitiesOverride: r.capabilities_override, contextOverride: r.context_override, status: r.status, providerName: r.provider_name, connectionName: r.connection_name, context: r.context_override ?? m.context })), pricing, usage: { totals: { requests: _num(tot.requests), ok: _num(tot.ok), tokensIn: _num(tot.tokens_in), tokensOut: _num(tot.tokens_out), cost: String(tot.cost ?? '0'), avgLatency: _num(tot.avg_latency) }, day, perDay, currency: String(m.currency).trim() }, statuses: MODEL_STATUSES, mappingStatuses: PROVIDER_MODEL_STATUSES };
	}));

	// Models list POSTs (admin/models): bulk / provider / create / update / delete.
	app.post('/api/admin/models/bulk', poster('models', async (database, body, userRow) => {
		const status = _parseEnum(MODEL_STATUSES, body.status);
		const ids = [...new Set((Array.isArray(body.ids) ? body.ids : (body.ids ? [body.ids] : [])).map((v) => String(v)).filter(Boolean))];
		if (!status) _fail(400, 'Invalid status');
		if (!ids.length) _fail(400, 'Select at least one model');
		const rows = _rowsOf(await database.execute(sql`select id, status from model where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
		if (!rows.length) _fail(404, 'No matching models');
		await database.transaction(async (tx) => {
			for (const r of rows) {
				if (r.status === status) continue;
				await tx.execute(sql`update model set status = ${status}, updated_at = now() where id = ${r.id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.status_set', resource: 'model', resourceId: r.id, before: { status: r.status }, after: { status } });
			}
		});
		return { changed: rows.length, message: `Status set to ${status} on ${rows.length} model(s).` };
	}));
	app.post('/api/admin/models/provider', poster('models', async (database, body, userRow) => {
		const providerId = String(body.providerId ?? '').trim();
		const status = _parseEnum(MODEL_STATUSES, body.status);
		if (!providerId) _fail(400, 'Missing provider');
		if (!status) _fail(400, 'Invalid status');
		const mine = _rowsOf(await database.execute(sql`select id from model where provider_id = ${providerId}`));
		if (!mine.length) _fail(404, 'That provider has no models');
		const rows = _rowsOf(await database.execute(sql`select id, status from model where provider_id = ${providerId}`));
		await database.transaction(async (tx) => {
			for (const r of rows) {
				if (r.status === status) continue;
				await tx.execute(sql`update model set status = ${status}, updated_at = now() where id = ${r.id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.status_set', resource: 'model', resourceId: r.id, before: { status: r.status }, after: { status } });
			}
		});
		return { changed: rows.length, message: `Status set to ${status} on ${rows.length} model(s).` };
	}));
	app.post('/api/admin/models/create', poster('models', async (database, body, userRow) => {
		const providerId = String(body.providerId ?? '').trim();
		const name = _cleanField(body.name, 200);
		const slug = _parseSlug(body.slug);
		const family = body.family ? _cleanField(body.family, 120) : null;
		const developer = body.developer ? _cleanField(body.developer, 200) : null;
		const description = body.description ? _cleanField(body.description, 2000) : null;
		const modality = _parseJson(body.modality);
		const capabilities = _parseFlags(body.capabilities);
		const status = _parseEnum(MODEL_STATUSES, body.status);
		let currency = String(body.currency ?? '').trim().toUpperCase() || 'USD';
		if (!/^[A-Z]{3}$/.test(currency)) _fail(400, 'Currency must be a 3-letter code');
		const input = _parseMicros(String(body.inputUsd ?? ''));
		const output = _parseMicros(String(body.outputUsd ?? ''));
		const ctxRaw = String(body.context ?? '').trim(); const mxRaw = String(body.maxOutput ?? '').trim();
		const context = ctxRaw ? _parseInt(ctxRaw, 1, 100000000) : null; const maxOutput = mxRaw ? _parseInt(mxRaw, 1, 100000000) : null;
		const pmRaw = String(body.providerModelId ?? '').trim();
		const providerModelId = pmRaw ? _parseSlug(pmRaw) : slug;
		if (!providerModelId) _fail(400, 'Upstream model id must be a slug');
		if (!providerId || !name || !slug) _fail(400, 'Provider, name and slug required');
		if (!status) _fail(400, 'Invalid status');
		if (modality === null || capabilities === null) _fail(400, 'Modality/capabilities must be JSON objects');
		if ((ctxRaw && context === null) || (mxRaw && maxOutput === null)) _fail(400, 'Context and max output must be positive integers');
		if (input === null || output === null) _fail(400, 'Prices must be non-negative USD per 1M tokens');
		const parent = _rowsOf(await database.execute(sql`select id from provider where id = ${providerId} limit 1`));
		if (!parent.length) _fail(400, 'Unknown provider');
		const now = new Date();
		const modelId = _newId(_IDP.model);
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into model (id, provider_id, name, slug, family, developer, description, modality, capabilities, context, max_output, input_price, output_price, currency, status) values (${modelId}, ${providerId}, ${name}, ${slug}, ${family}, ${developer}, ${description}, ${JSON.stringify(modality)}::jsonb, ${JSON.stringify(capabilities)}::jsonb, ${context}, ${maxOutput}, ${input.toString()}, ${output.toString()}, ${currency}, ${status})`);
				await tx.execute(sql`insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, context_override, status) values (${_newId(_IDP.providerModel)}, ${modelId}, ${providerId}, null, ${providerModelId}, true, '{}'::jsonb, null, 'available')`);
				await tx.execute(sql`insert into pricing_rule (id, model_id, provider_model_id, version, currency, input_price, cached_input_price, output_price, reasoning_price, effective_from, effective_until, created_by) values (${_newId(_IDP.pricingRule)}, ${modelId}, null, 1, ${currency}, ${input.toString()}, null, ${output.toString()}, null, ${now.toISOString()}, null, ${userRow.id})`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.create', resource: 'model', resourceId: modelId, after: { name, slug, status, currency, context, maxOutput } });
				await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.create', resource: 'provider_model', resourceId: modelId, after: { modelId, providerId, providerModelId, enabled: true, status: 'available' } });
				await _audit(tx, { actorUserId: userRow.id, action: 'pricing_rule.create', resource: 'pricing_rule', resourceId: modelId, after: { modelId, version: 1, currency, inputPrice: input.toString(), outputPrice: output.toString() } });
			});
		} catch (err) { _fail(409, `Could not create model: ${err.message ?? 'insert failed'}`); }
		return { created: slug, message: `Model "${slug}" created with its first mapping and price v1.` };
	}));
	app.post('/api/admin/models/update', poster('models', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const name = _cleanField(body.name, 200);
		const slug = _parseSlug(body.slug);
		const family = body.family ? _cleanField(body.family, 120) : null;
		const developer = body.developer ? _cleanField(body.developer, 200) : null;
		const description = body.description ? _cleanField(body.description, 2000) : null;
		const modality = _parseJson(body.modality);
		const capabilities = _parseFlags(body.capabilities);
		const status = _parseEnum(MODEL_STATUSES, body.status);
		let currency = String(body.currency ?? '').trim().toUpperCase() || 'USD';
		if (!/^[A-Z]{3}$/.test(currency)) _fail(400, 'Currency must be a 3-letter code');
		const ctxRaw = String(body.context ?? '').trim(); const mxRaw = String(body.maxOutput ?? '').trim();
		const context = ctxRaw ? _parseInt(ctxRaw, 1, 100000000) : null; const maxOutput = mxRaw ? _parseInt(mxRaw, 1, 100000000) : null;
		if (!id) _fail(400, 'Missing model id');
		if (!name || !slug) _fail(400, 'Name and slug required');
		if (!status) _fail(400, 'Invalid status');
		if (modality === null || capabilities === null) _fail(400, 'Modality/capabilities must be JSON objects');
		if ((ctxRaw && context === null) || (mxRaw && maxOutput === null)) _fail(400, 'Context and max output must be positive integers');
		const before = _rowsOf(await database.execute(sql`select * from model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Model not found');
		const after = { name, slug, family, developer, description, modality, capabilities, context, maxOutput, currency, status };
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`update model set name = ${name}, slug = ${slug}, family = ${family}, developer = ${developer}, description = ${description}, modality = ${JSON.stringify(modality)}::jsonb, capabilities = ${JSON.stringify(capabilities)}::jsonb, context = ${context}, max_output = ${maxOutput}, currency = ${currency}, status = ${status}, updated_at = now() where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.update', resource: 'model', resourceId: id, before: { name: before.name, slug: before.slug, family: before.family, developer: before.developer, description: before.description, modality: before.modality, capabilities: before.capabilities, context: before.context, maxOutput: before.max_output, currency: before.currency, status: before.status }, after });
			});
		} catch (err) { _fail(409, `Could not update model: ${err.message ?? 'update failed'}`); }
		return { updated: id, message: `Model "${slug}" saved.` };
	}));
	app.post('/api/admin/models/delete', poster('models', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing model id');
		const before = _rowsOf(await database.execute(sql`select id, name, slug, status, provider_id from model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Model not found');
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`delete from model where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.delete', resource: 'model', resourceId: id, before: { name: before.name, slug: before.slug, status: before.status, providerId: before.provider_id } });
			});
		} catch { _fail(409, 'Model has request history — disable it instead'); }
		return { deleted: id, message: `Model "${before.slug}" deleted.` };
	}));
	// Model detail POSTs (admin/models/[id]): update + mapping.
	app.post('/api/admin/models/:id/update', poster('models', async (database, body, userRow, req) => {
		const id = String(body.id ?? req.params?.id ?? '').trim();
		const name = _cleanField(body.name, 200);
		const slug = _parseSlug(body.slug);
		const family = body.family ? _cleanField(body.family, 120) : null;
		const developer = body.developer ? _cleanField(body.developer, 200) : null;
		const description = body.description ? _cleanField(body.description, 2000) : null;
		const modality = _parseJson(body.modality);
		const capabilities = _parseFlags(body.capabilities);
		const status = _parseEnum(MODEL_STATUSES, body.status);
		const ctxRaw = String(body.context ?? '').trim(); const mxRaw = String(body.maxOutput ?? '').trim();
		const context = ctxRaw ? _parseInt(ctxRaw, 1, 100000000) : null; const maxOutput = mxRaw ? _parseInt(mxRaw, 1, 100000000) : null;
		if (!id) _fail(400, 'Missing model id');
		if (!name || !slug) _fail(400, 'Name and slug required');
		if (!status) _fail(400, 'Invalid status');
		if (modality === null || capabilities === null) _fail(400, 'Modality/capabilities must be JSON objects');
		if ((ctxRaw && context === null) || (mxRaw && maxOutput === null)) _fail(400, 'Context and max output must be positive integers');
		const before = _rowsOf(await database.execute(sql`select * from model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Model not found');
		const after = { name, slug, family, developer, description, modality, capabilities, context, maxOutput, status };
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`update model set name = ${name}, slug = ${slug}, family = ${family}, developer = ${developer}, description = ${description}, modality = ${JSON.stringify(modality)}::jsonb, capabilities = ${JSON.stringify(capabilities)}::jsonb, context = ${context}, max_output = ${maxOutput}, status = ${status}, updated_at = now() where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.update', resource: 'model', resourceId: id, before: { name: before.name, slug: before.slug, family: before.family, developer: before.developer, description: before.description, modality: before.modality, capabilities: before.capabilities, context: before.context, maxOutput: before.max_output, status: before.status }, after });
			});
		} catch (err) { _fail(409, `Could not update model: ${err.message ?? 'update failed'}`); }
		return { updated: id, message: `Model "${slug}" saved.` };
	}));
	app.post('/api/admin/models/:id/mapping', poster('models', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const enabled = _parseBool(body.enabled);
		const status = _parseEnum(PROVIDER_MODEL_STATUSES, body.status);
		if (!id) _fail(400, 'Missing mapping id');
		if (!status) _fail(400, 'Invalid status');
		const before = _rowsOf(await database.execute(sql`select * from provider_model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Mapping not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update provider_model set enabled = ${enabled}, status = ${status}, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.update', resource: 'provider_model', resourceId: id, before: { enabled: before.enabled, status: before.status }, after: { enabled, status } });
		});
		return { mappingUpdated: id, message: 'Mapping saved.' };
	}));

	// Mappings (admin/models/mappings): GET + create/update/delete.
	app.post('/api/admin/models/mappings/create', poster('models', async (database, body, userRow) => {
		const modelId = String(body.modelId ?? '').trim();
		const providerId = String(body.providerId ?? '').trim();
		const connectionRaw = String(body.connectionId ?? '').trim();
		const providerModelId = _parseSlug(body.providerModelId);
		const enabled = _parseBool(body.enabled);
		const capabilitiesOverride = _parseFlags(body.capabilitiesOverride);
		const ctxRaw = String(body.contextOverride ?? '').trim();
		const contextOverride = ctxRaw ? _parseInt(ctxRaw, 1, 100000000) : null;
		if (!modelId || !providerId) _fail(400, 'Model and provider required');
		if (!providerModelId) _fail(400, 'Upstream model id required');
		if (capabilitiesOverride === null) _fail(400, 'Capabilities override must be a JSON flags object');
		if (ctxRaw && contextOverride === null) _fail(400, 'Context override must be a positive integer');
		const mrow = _rowsOf(await database.execute(sql`select id from model where id = ${modelId} limit 1`));
		if (!mrow.length) _fail(400, 'Unknown model');
		let connectionId = null;
		if (connectionRaw) {
			const c = _rowsOf(await database.execute(sql`select id from connection where id = ${connectionRaw} limit 1`));
			if (!c.length) _fail(400, 'Unknown connection');
			connectionId = c[0].id;
		}
		const id = _newId(_IDP.providerModel);
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, context_override, status) values (${id}, ${modelId}, ${providerId}, ${connectionId}, ${providerModelId}, ${enabled}, ${JSON.stringify(capabilitiesOverride)}::jsonb, ${contextOverride ?? null}, 'available')`);
				await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.create', resource: 'provider_model', resourceId: id, after: { modelId, providerId, connectionId, providerModelId, enabled, capabilitiesOverride, contextOverride: contextOverride ?? null, status: 'available' } });
			});
		} catch (err) { _fail(409, `Could not create mapping: ${err.message ?? 'insert failed'}`); }
		return { created: id, message: `Mapping "${providerModelId}" created.` };
	}));
	app.post('/api/admin/models/mappings/update', poster('models', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const providerModelId = _parseSlug(body.providerModelId);
		const enabled = _parseBool(body.enabled);
		const capabilitiesOverride = _parseFlags(body.capabilitiesOverride);
		const ctxRaw = String(body.contextOverride ?? '').trim();
		const contextOverride = ctxRaw ? _parseInt(ctxRaw, 1, 100000000) : null;
		const status = _parseEnum(PROVIDER_MODEL_STATUSES, body.status);
		const connectionRaw = String(body.connectionId ?? '').trim();
		if (!id) _fail(400, 'Missing mapping id');
		if (!providerModelId) _fail(400, 'Upstream model id required');
		if (capabilitiesOverride === null) _fail(400, 'Capabilities override must be a JSON flags object');
		if (ctxRaw && contextOverride === null) _fail(400, 'Context override must be a positive integer');
		if (!status) _fail(400, 'Invalid status');
		const before = _rowsOf(await database.execute(sql`select * from provider_model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Mapping not found');
		let connectionId = null;
		if (connectionRaw) {
			const c = _rowsOf(await database.execute(sql`select id, provider_id from connection where id = ${connectionRaw} limit 1`))[0];
			if (!c || c.provider_id !== before.provider_id) _fail(400, 'Connection does not belong to this mapping\u2019s provider');
			connectionId = c.id;
		}
		const after = { providerModelId, connectionId, enabled, capabilitiesOverride, contextOverride: contextOverride ?? null, status };
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`update provider_model set provider_model_id = ${providerModelId}, connection_id = ${connectionId}, enabled = ${enabled}, capabilities_override = ${JSON.stringify(capabilitiesOverride)}::jsonb, context_override = ${contextOverride ?? null}, status = ${status}, updated_at = now() where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.update', resource: 'provider_model', resourceId: id, before: { providerModelId: before.provider_model_id, connectionId: before.connection_id, enabled: before.enabled, capabilitiesOverride: before.capabilities_override, contextOverride: before.context_override, status: before.status }, after });
			});
		} catch (err) { _fail(409, `Could not update mapping: ${err.message ?? 'update failed'}`); }
		return { updated: id, message: `Mapping "${providerModelId}" saved.` };
	}));
	app.post('/api/admin/models/mappings/delete', poster('models', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing mapping id');
		const before = _rowsOf(await database.execute(sql`select * from provider_model where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Mapping not found');
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`delete from provider_model where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.delete', resource: 'provider_model', resourceId: id, before: { modelId: before.model_id, providerId: before.provider_id, providerModelId: before.provider_model_id, status: before.status } });
			});
		} catch (err) { _fail(409, `Could not delete mapping: ${err.message ?? 'delete failed'}`); }
		return { deleted: id, message: `Mapping "${before.provider_model_id}" deleted.` };
	}));
	// Pricing (admin/models/pricing): GET + preview/apply.
	const _priceField = (raw) => { const s = String(raw ?? '').trim(); if (!s) return { ok: true, value: '0' }; const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s); if (!m) return { ok: false }; try { const v = BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0')); if (v > 1000000000000n * 1000000n) return { ok: false }; return { ok: true, value: v.toString() }; } catch { return { ok: false }; } };
	const _optPrice = (raw) => { const s = String(raw ?? '').trim(); if (!s) return { ok: true, value: null }; const r = _priceField(s); return r.ok ? { ok: true, value: r.value } : { ok: false }; };
	const _parseProposal = (body) => {
		const modelId = String(body.modelId ?? '').trim();
		const pmRaw = String(body.providerModelId ?? '').trim();
		let currency = String(body.currency ?? '').trim().toUpperCase() || 'USD';
		if (!/^[A-Z]{3}$/.test(currency)) currency = null;
		const input = _priceField(body.inputPrice); const cached = _optPrice(body.cachedInputPrice);
		const output = _priceField(body.outputPrice); const reasoning = _optPrice(body.reasoningPrice);
		let effectiveFrom = null;
		const ef = String(body.effectiveFrom ?? '').trim();
		if (!ef) effectiveFrom = new Date(); else { const d = new Date(`${ef}T00:00:00.000Z`); if (Number.isNaN(d.getTime())) effectiveFrom = null; else effectiveFrom = d; }
		if (!modelId) return { error: 'Missing model' };
		if (!currency) return { error: 'Currency must be a 3-letter code' };
		if (!input.ok || !cached.ok || !output.ok || !reasoning.ok) return { error: 'Prices must be non-negative decimal USD per 1M tokens' };
		if (!effectiveFrom) return { error: 'Effective from must be a YYYY-MM-DD date' };
		return { modelId, providerModelId: pmRaw || null, currency, inputPrice: input.value, cachedInputPrice: cached.value, outputPrice: output.value, reasoningPrice: reasoning.value, effectiveFrom };
	};
	app.post('/api/admin/models/pricing/preview', poster('models', async (database, body) => {
		const p = _parseProposal(body);
		if (p.error) _fail(400, p.error);
		const m = _rowsOf(await database.execute(sql`select id, slug from model where id = ${p.modelId} limit 1`))[0];
		if (!m) _fail(404, 'Model not found');
		if (p.providerModelId) { const mp = _rowsOf(await database.execute(sql`select id from provider_model where id = ${p.providerModelId} limit 1`)); if (!mp.length) _fail(400, 'Unknown mapping'); }
		const cur = p.providerModelId
			? _rowsOf(await database.execute(sql`select * from pricing_rule where model_id = ${p.modelId} and provider_model_id = ${p.providerModelId} and effective_until is null order by version desc limit 1`))[0]
			: _rowsOf(await database.execute(sql`select * from pricing_rule where model_id = ${p.modelId} and provider_model_id is null and effective_until is null order by version desc limit 1`))[0];
		const nextVersion = (cur ? _num(cur.version) : 0) + 1;
		return { preview: true, modelSlug: m.slug, current: cur ? { version: _num(cur.version), inputPriceMicro: micros(cur.input_price), outputPriceMicro: micros(cur.output_price) } : null, nextVersion, proposal: { ...p, effectiveFrom: p.effectiveFrom.toISOString() } };
	}));
	app.post('/api/admin/models/pricing/apply', poster('models', async (database, body, userRow) => {
		if (String(body.approved ?? '').trim() !== 'on') _fail(400, 'Tick "approved" to apply a new price version');
		const p = _parseProposal(body);
		if (p.error) _fail(400, p.error);
		const m = _rowsOf(await database.execute(sql`select id, slug from model where id = ${p.modelId} limit 1`))[0];
		if (!m) _fail(404, 'Model not found');
		if (p.providerModelId) { const mp = _rowsOf(await database.execute(sql`select id from provider_model where id = ${p.providerModelId} limit 1`)); if (!mp.length) _fail(400, 'Unknown mapping'); }
		const now = new Date();
		const cur = p.providerModelId
			? _rowsOf(await database.execute(sql`select * from pricing_rule where model_id = ${p.modelId} and provider_model_id = ${p.providerModelId} order by version desc limit 1`))[0]
			: _rowsOf(await database.execute(sql`select * from pricing_rule where model_id = ${p.modelId} and provider_model_id is null order by version desc limit 1`))[0];
		const nextVersion = (cur ? _num(cur.version) : 0) + 1;
		const id = _newId(_IDP.pricingRule);
		try {
			await database.transaction(async (tx) => {
				if (cur && cur.effective_until === null) await tx.execute(sql`update pricing_rule set effective_until = ${now.toISOString()} where id = ${cur.id}`);
				await tx.execute(sql`insert into pricing_rule (id, model_id, provider_model_id, version, currency, input_price, cached_input_price, output_price, reasoning_price, effective_from, effective_until, created_by) values (${id}, ${p.modelId}, ${p.providerModelId}, ${nextVersion}, ${p.currency}, ${p.inputPrice}, ${p.cachedInputPrice}, ${p.outputPrice}, ${p.reasoningPrice}, ${p.effectiveFrom.toISOString()}, null, ${userRow.id})`);
				await _audit(tx, { actorUserId: userRow.id, action: 'pricing_rule.apply', resource: 'pricing_rule', resourceId: id, before: cur ? { version: _num(cur.version), inputPrice: micros(cur.input_price), cachedInputPrice: cur.cached_input_price == null ? null : micros(cur.cached_input_price), outputPrice: micros(cur.output_price), reasoningPrice: cur.reasoning_price == null ? null : micros(cur.reasoning_price), closedAt: now.toISOString() } : null, after: { modelId: p.modelId, providerModelId: p.providerModelId, version: nextVersion, currency: p.currency, inputPrice: p.inputPrice, cachedInputPrice: p.cachedInputPrice, outputPrice: p.outputPrice, reasoningPrice: p.reasoningPrice, effectiveFrom: p.effectiveFrom.toISOString() } });
			});
		} catch (err) { _fail(409, `Could not apply price version: ${err.message ?? 'insert failed'}`); }
		return { applied: id, message: `Pricing v${nextVersion} applied to ${m.slug} — v${cur ? _num(cur.version) : 0} closed, v${nextVersion} inserted.` };
	}));

	// Sync (admin/models/sync): GET + fetch/apply.
	app.post('/api/admin/models/sync/fetch', poster('models', async (database, body) => {
		const providerId = String(body.providerId ?? '').trim();
		const tier = String(body.tier ?? 'all').trim();
		if (!providerId) _fail(400, 'Missing provider');
		const p = _rowsOf(await database.execute(sql`select id, name from provider where id = ${providerId} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${providerId} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		let cred = {};
		if (conns[0]) {
			const cr = _rowsOf(await database.execute(sql`select secret_enc from credential where connection_id = ${conns[0].id} order by priority, id limit 1`))[0];
			if (cr) { try { cred = _decCred(cr.secret_enc); } catch { _fail(400, 'Connection credential could not be decrypted'); } }
		}
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		let upstream;
		try {
			const catalog = await _fetchCatalog(baseUrl, cred);
			if (catalog.status !== 200) _fail(502, `Upstream returned HTTP ${catalog.status}`);
			upstream = catalog.models;
		} catch (err) { console.error('[admin/models/sync] upstream fetch failed', err); _fail(502, 'upstream request failed'); }
		const t0 = Date.now();
		const local = _rowsOf(await database.execute(sql`select pm.id, pm.provider_model_id, pm.context_override, pm.enabled, pm.status, m.id as model_id, m.slug as model_slug, m.name as model_name, m.context as model_context, m.input_price::text as model_input_price, m.output_price::text as model_output_price from provider_model pm join model m on m.id = pm.model_id where pm.provider_id = ${providerId}`));
		const seen = new Set(upstream.map((u) => _matchKey(u.slug)));
		const localByKey = new Map(local.map((l) => [_matchKey(l.provider_model_id), l]));
		const additions = [];
		for (const u of upstream) {
			if (localByKey.has(_matchKey(u.slug))) continue;
			additions.push({ slug: u.slug, name: u.name || u.slug, context: null, providerModelId: u.slug, inputPriceMicro: '0', outputPriceMicro: '0', json: JSON.stringify({ slug: u.slug, name: u.name || u.slug, context: '', providerModelId: u.slug, inputPriceMicro: '0', outputPriceMicro: '0' }) });
		}
		const changes = [];
		for (const u of upstream) {
			const l = localByKey.get(_matchKey(u.slug));
			if (!l) continue;
			const reasons = [];
			if (l.provider_model_id !== u.slug) reasons.push(`upstream id ${u.slug} vs mapped ${l.provider_model_id}`);
			if (reasons.length) changes.push({ id: l.id, slug: l.model_slug, providerModelId: u.slug, contextOverride: l.context_override, reasons, json: JSON.stringify({ id: l.id, providerModelId: u.slug, contextOverride: l.context_override ?? '' }) });
		}
		const removals = local.filter((l) => !seen.has(_matchKey(l.provider_model_id))).map((l) => ({ id: l.id, slug: l.model_slug, providerModelId: l.provider_model_id }));
		return { fetched: { tier, url: `${String(baseUrl).trim().replace(/\/+$/, '')}/models`, latencyMs: Date.now() - t0, total: upstream.length, providerId, providerName: p.name, upstreamCount: upstream.length, checkedCount: local.length, additions, changes, removals } };
	}));
	app.post('/api/admin/models/sync/apply', poster('models', async (database, body, userRow) => {
		const providerId = String(body.providerId ?? '').trim();
		if (!providerId) _fail(400, 'Missing provider');
		const p = _rowsOf(await database.execute(sql`select id, name from provider where id = ${providerId} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const addRaw = Array.isArray(body.add) ? body.add : (body.add ? [body.add] : []);
		const chgRaw = Array.isArray(body.change) ? body.change : (body.change ? [body.change] : []);
		const parseAdd = (raw) => { try { const e = JSON.parse(String(raw)); const slug = _parseSlug(e.slug); const pmid = _parseSlug(e.providerModelId); const ctxR = String(e.context ?? '').trim(); const ctx = ctxR ? _parseInt(ctxR, 1, 100000000) : null; const ip = /^\d{1,15}$/.test(String(e.inputPriceMicro ?? '')) ? String(e.inputPriceMicro) : null; const op = /^\d{1,15}$/.test(String(e.outputPriceMicro ?? '')) ? String(e.outputPriceMicro) : null; if (!slug || !pmid || !ip || !op) return null; if (ctxR && ctx === null) return null; return { slug, name: String(e.name ?? slug).slice(0, 200) || slug, context: ctx, providerModelId: pmid, inputPriceMicro: ip, outputPriceMicro: op }; } catch { return null; } };
		const parseChg = (raw) => { try { const e = JSON.parse(String(raw)); const id = String(e.id ?? '').trim(); const pmid = _parseSlug(e.providerModelId); const ctxR = String(e.contextOverride ?? '').trim(); const ctx = ctxR ? _parseInt(ctxR, 1, 100000000) : null; if (!id || !pmid) return null; if (ctxR && ctx === null) return null; return { id, providerModelId: pmid, contextOverride: ctxR ? ctx : null }; } catch { return null; } };
		const additions = addRaw.map(parseAdd).filter(Boolean);
		const changes = chgRaw.map(parseChg).filter(Boolean);
		if (!additions.length && !changes.length) _fail(400, 'Nothing ticked to apply');
		let added = 0, mapped = 0, changed = 0;
		for (const row of additions) {
			const existing = _rowsOf(await database.execute(sql`select id from model where slug = ${row.slug} limit 1`));
			const now = new Date();
			if (existing.length) {
				await database.transaction(async (tx) => {
					const mappingId = _newId(_IDP.providerModel);
					await tx.execute(sql`insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, context_override, status) values (${mappingId}, ${existing[0].id}, ${providerId}, null, ${row.providerModelId}, true, '{}'::jsonb, ${row.context}, 'available')`);
					await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.create', resource: 'provider_model', resourceId: mappingId, after: { modelId: existing[0].id, providerId, providerModelId: row.providerModelId, contextOverride: row.context, status: 'available', source: 'catalog_sync' } });
				});
				mapped += 1; continue;
			}
			await database.transaction(async (tx) => {
				const modelId = _newId(_IDP.model);
				await tx.execute(sql`insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, modality, capabilities) values (${modelId}, ${providerId}, ${row.name}, ${row.slug}, ${row.context}, ${row.inputPriceMicro}, ${row.outputPriceMicro}, 'USD', 'active', '{}'::jsonb, '{}'::jsonb)`);
				const mappingId = _newId(_IDP.providerModel);
				await tx.execute(sql`insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, context_override, status) values (${mappingId}, ${modelId}, ${providerId}, null, ${row.providerModelId}, true, '{}'::jsonb, null, 'available')`);
				await tx.execute(sql`insert into pricing_rule (id, model_id, provider_model_id, version, currency, input_price, output_price, effective_from, created_by) values (${_newId(_IDP.pricingRule)}, ${modelId}, null, 1, 'USD', ${row.inputPriceMicro}, ${row.outputPriceMicro}, ${now.toISOString()}, ${userRow.id})`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.create', resource: 'model', resourceId: modelId, after: { slug: row.slug, source: 'catalog_sync' } });
			});
			added += 1;
		}
		for (const row of changes) {
			const before = _rowsOf(await database.execute(sql`select * from provider_model where id = ${row.id} limit 1`))[0];
			if (!before) continue;
			await database.transaction(async (tx) => {
				await tx.execute(sql`update provider_model set provider_model_id = ${row.providerModelId}, context_override = ${row.contextOverride}, updated_at = now() where id = ${row.id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'provider_model.update', resource: 'provider_model', resourceId: row.id, before: { providerModelId: before.provider_model_id, contextOverride: before.context_override }, after: { providerModelId: row.providerModelId, contextOverride: row.contextOverride, source: 'catalog_sync' } });
			});
			changed += 1;
		}
		return { added, mapped, changed, message: `Sync applied: ${added} added, ${mapped} mapped, ${changed} changed.` };
	}));

	// ---- parity block: projects ----
	// Project detail (admin/projects/[id]) + setStatus.
	app.get('/api/admin/projects/:id', handler('projects', async (database, url) => {
		const id = String(url.pathname.split('/').pop());
		const proj = _rowsOf(await database.execute(sql`select p.id, p.name, p.slug, p.description, p.status, p.created_at, p.updated_at, w.id as workspace_id, w.name as workspace_name from project p join workspace w on w.id = p.workspace_id where p.id = ${id} limit 1`))[0];
		if (!proj) { const e = new ctx.HttpError(404, 'Project not found'); throw e; }
		const environments = _rowsOf(await database.execute(sql`select id, name, slug, type, status, routing_policy_id from environment where project_id = ${id} order by name`));
		const keys = _rowsOf(await database.execute(sql`select id, name, prefix, status, environment_id, last_used_at, revoked_at, created_at from api_key where project_id = ${id} order by created_at`));
		const usage = _rowsOf(await database.execute(sql`select count(*)::int as requests, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where project_id = ${id}`))[0] ?? { requests: 0, tokensIn: 0, tokensOut: 0, cost: '0' };
		return { project: { id: proj.id, name: proj.name, slug: proj.slug, description: proj.description, status: proj.status, createdAt: proj.created_at, updatedAt: proj.updated_at, workspaceId: proj.workspace_id, workspaceName: proj.workspace_name }, environments: environments.map((e) => ({ id: e.id, name: e.name, slug: e.slug, type: e.type, status: e.status, routingPolicyId: e.routing_policy_id })), keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status, environmentId: k.environment_id, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, createdAt: k.created_at })), usage: { requests: _num(usage.requests), tokensIn: _num(usage.tokens_in), tokensOut: _num(usage.tokens_out), cost: String(usage.cost ?? '0') }, statuses: PROJECT_STATUSES };
	}));
	app.post('/api/admin/projects/setStatus', poster('projects', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const status = String(body.status ?? '').trim();
		if (!id) _fail(400, 'Missing project id');
		if (!PROJECT_STATUSES.includes(status)) _fail(400, 'Invalid status');
		const target = _rowsOf(await database.execute(sql`select status, workspace_id from project where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'Project not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update project set status = ${status} where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'project.status_set', resource: 'project', resourceId: id, workspaceId: target.workspace_id, before: { status: target.status }, after: { status } });
		});
		return { statusSet: id };
	}));
	// Providers list POSTs (admin/providers): create/update/delete.
	app.post('/api/admin/providers/create', poster('providers', async (database, body, userRow) => {
		const name = _cleanField(body.name);
		const slug = _parseSlug(body.slug);
		const description = body.description ? _cleanField(body.description, 2000) : null;
		const type = body.type ? _cleanField(body.type) : null;
		const status = _parseEnum(PROVIDER_STATUSES, body.status);
		const tier = _parseEnum(PROVIDER_TIERS, body.tier);
		const homepage = body.homepage ? _cleanField(body.homepage, 2000) : null;
		const documentationUrl = body.documentationUrl ? _cleanField(body.documentationUrl, 2000) : null;
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		if (!name || !slug || !status || !tier || priority === null) _fail(400, 'Name, slug, status, tier and priority are all required');
		if (homepage !== null && !/^https?:\/\//.test(homepage)) _fail(400, 'Homepage must be an http(s) URL');
		if (documentationUrl !== null && !/^https?:\/\//.test(documentationUrl)) _fail(400, 'Documentation URL must be an http(s) URL');
		const dup = _rowsOf(await database.execute(sql`select id from provider where slug = ${slug} limit 1`));
		if (dup.length) _fail(400, 'A provider with this slug already exists');
		const id = _newId(_IDP.provider);
		const after = { name, slug, description, type, status, tier, homepage, documentationUrl, enabled: _parseBool(body.enabled), priority };
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into provider (id, name, slug, description, type, status, tier, homepage, documentation_url, enabled, priority, base_url, credentials_enc) values (${id}, ${name}, ${slug}, ${description}, ${type}, ${status}, ${tier}, ${homepage}, ${documentationUrl}, ${after.enabled}, ${priority}, '', '')`);
			await _audit(tx, { actorUserId: userRow.id, action: 'provider.create', resource: 'provider', resourceId: id, after });
		});
		return { created: name };
	}));
	app.post('/api/admin/providers/update', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const name = _cleanField(body.name);
		const slug = _parseSlug(body.slug);
		const description = body.description ? _cleanField(body.description, 2000) : null;
		const type = body.type ? _cleanField(body.type) : null;
		const status = _parseEnum(PROVIDER_STATUSES, body.status);
		const tier = _parseEnum(PROVIDER_TIERS, body.tier);
		const homepage = body.homepage ? _cleanField(body.homepage, 2000) : null;
		const documentationUrl = body.documentationUrl ? _cleanField(body.documentationUrl, 2000) : null;
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		if (!id) _fail(400, 'Missing provider id');
		if (!name || !slug || !status || !tier || priority === null) _fail(400, 'Name, slug, status, tier and priority are all required');
		const dup = _rowsOf(await database.execute(sql`select id from provider where slug = ${slug} limit 1`))[0];
		if (dup && dup.id !== id) _fail(400, 'A provider with this slug already exists');
		const before = _rowsOf(await database.execute(sql`select * from provider where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Provider not found');
		const after = { name, slug, description, type, status, tier, homepage, documentationUrl, enabled: _parseBool(body.enabled), priority };
		await database.transaction(async (tx) => {
			await tx.execute(sql`update provider set name = ${name}, slug = ${slug}, description = ${description}, type = ${type}, status = ${status}, tier = ${tier}, homepage = ${homepage}, documentation_url = ${documentationUrl}, enabled = ${after.enabled}, priority = ${priority}, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'provider.update', resource: 'provider', resourceId: id, before: { name: before.name, slug: before.slug, description: before.description, type: before.type, status: before.status, tier: before.tier, homepage: before.homepage, documentationUrl: before.documentation_url, enabled: before.enabled, priority: before.priority }, after });
		});
		return { updated: id };
	}));
	app.post('/api/admin/providers/delete', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing provider id');
		const before = _rowsOf(await database.execute(sql`select id, name, slug from provider where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Provider not found');
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`delete from provider where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'provider.delete', resource: 'provider', resourceId: id, before });
			});
		} catch { _fail(409, 'Provider has request history — disable it instead'); }
		return { deleted: id };
	}));

	// Provider detail (admin/providers/[id]): GET + fetchCatalog/enable/disable/testCredential/testAll/testModel/chat/strategy.
	app.get('/api/admin/providers/:id/connections', handler('providers', async (database, url) => {
		const id = String(url.pathname.split('/')[4]);
		const p = _rowsOf(await database.execute(sql`select id, name from provider where id = ${id} limit 1`))[0];
		if (!p) { const e = new ctx.HttpError(404, 'Provider not found'); throw e; }
		const rows = _rowsOf(await database.execute(sql`select id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status, config, created_at, updated_at from connection where provider_id = ${id} order by priority, name`));
		const counts = _rowsOf(await database.execute(sql`select connection_id, count(*)::int as n, count(*) filter (where status = 'healthy')::int as healthy from credential group by connection_id`));
		const byConn = new Map(counts.map((c) => [c.connection_id, c]));
		return { provider: p, authTypes: CONNECTION_AUTH_TYPES, connections: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, baseUrl: r.base_url, region: r.region, authType: r.auth_type, timeoutMs: r.timeout_ms, priority: r.priority, enabled: r.enabled, healthStatus: r.health_status, config: r.config, createdAt: r.created_at, updatedAt: r.updated_at, credentialCount: _num(byConn.get(r.id)?.n), credentialHealthy: _num(byConn.get(r.id)?.healthy) })) };
	}));
	app.get('/api/admin/providers/:id/credentials', handler('providers', async (database, url) => {
		const id = String(url.pathname.split('/')[4]);
		const p = _rowsOf(await database.execute(sql`select id, name from provider where id = ${id} limit 1`))[0];
		if (!p) { const e = new ctx.HttpError(404, 'Provider not found'); throw e; }
		const conns = _rowsOf(await database.execute(sql`select id, name, slug from connection where provider_id = ${id} order by priority, name`));
		const filterConnection = url.searchParams.get('connection') ?? '';
		const filterStatus = url.searchParams.get('status') ?? '';
		const filterLastUsed = url.searchParams.get('lastUsed') ?? '';
		const poolRows = _rowsOf(await database.execute(sql`select cr.status from credential cr join connection c on c.id = cr.connection_id where c.provider_id = ${id}`));
		const buckets = { Healthy: 0, 'Rate Limited': 0, Cooldown: 0, Invalid: 0, Disabled: 0, Unknown: 0 };
		const toBucket = (s) => ({ healthy: 'Healthy', rate_limited: 'Rate Limited', cooldown: 'Cooldown', auth_failed: 'Invalid', invalid: 'Invalid', disabled: 'Disabled', unknown: 'Unknown' }[s] ?? 'Unknown');
		for (const r of poolRows) buckets[toBucket(r.status)] += 1;
		let rows = _rowsOf(await database.execute(sql`select cr.id, cr.connection_id, cr.name, cr.status, cr.priority, cr.weight, cr.last_used_at, cr.last_success_at, cr.last_error_at, cr.cooldown_until, cr.metadata, cr.created_at, cr.updated_at, c.name as connection_name from credential cr join connection c on c.id = cr.connection_id where c.provider_id = ${id} order by cr.priority, cr.name`));
		if (filterConnection) rows = rows.filter((r) => r.connection_id === filterConnection);
		if (filterStatus) rows = rows.filter((r) => r.status === filterStatus);
		if (filterLastUsed && /^\d+$/.test(filterLastUsed)) { const cut = Date.now() - Number(filterLastUsed) * 3600000; rows = rows.filter((r) => r.last_used_at && new Date(r.last_used_at).getTime() > cut); }
		const connName = new Map(conns.map((c) => [c.id, c.name]));
		return { provider: p, connections: conns, statuses: CREDENTIAL_STATUSES, lastUsedAges: LAST_USED_AGES, filters: { connection: filterConnection, status: filterStatus, lastUsed: filterLastUsed }, credentials: rows.map((r) => ({ id: r.id, connectionId: r.connection_id, name: r.name, status: r.status, priority: r.priority, weight: r.weight, lastUsedAt: r.last_used_at, lastSuccessAt: r.last_success_at, lastErrorAt: r.last_error_at, cooldownUntil: r.cooldown_until, metadata: r.metadata, createdAt: r.created_at, updatedAt: r.updated_at, connectionName: connName.get(r.connection_id) ?? '—' })), pool: { total: poolRows.length, buckets } };
	}));
	app.get('/api/admin/providers/:id', handler('providers', async (database, url) => {
		const id = String(url.pathname.split('/').pop());
		const p = _rowsOf(await database.execute(sql`select id, name, slug, description, type, status, tier, homepage, documentation_url, enabled, priority, created_at from provider where id = ${id} limit 1`))[0];
		if (!p) { const e = new ctx.HttpError(404, 'Provider not found'); throw e; }
		const allowDev = _allowDev();
		const conns = _rowsOf(await database.execute(sql`select id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, health_status from connection where provider_id = ${id} order by priority, name`));
		const baseUrl = conns[0]?.base_url ?? null;
		const credRows = _rowsOf(await database.execute(sql`select cr.id, cr.connection_id, cr.name, cr.status, c.name as conn_name from credential cr join connection c on c.id = cr.connection_id where c.provider_id = ${id} order by cr.priority, cr.name, cr.id`));
		const healthy = credRows.filter((r) => r.status === 'healthy').length;
		const unknown = credRows.filter((r) => r.status === 'unknown').length;
		const bad = credRows.filter((r) => ['auth_failed', 'invalid'].includes(r.status)).length;
		const cooldown = credRows.filter((r) => ['cooldown', 'rate_limited'].includes(r.status)).length;
		const models = _rowsOf(await database.execute(sql`select id, slug, name, context, input_price::text as input_price, output_price::text as output_price, status from model where provider_id = ${id} order by slug`));
		const mappings = _rowsOf(await database.execute(sql`select pm.id, pm.provider_model_id, m.slug as model_slug, pm.connection_id, pm.enabled, pm.status, pm.context_override from provider_model pm join model m on m.id = pm.model_id where pm.provider_id = ${id}`));
		const pricing = _rowsOf(await database.execute(sql`select pr.id, m.slug as model_slug, pr.version, pr.currency, pr.input_price::text as input_price, pr.cached_input_price::text as cached_input_price, pr.output_price::text as output_price, pr.reasoning_price::text as reasoning_price, pr.effective_from, pr.effective_until from pricing_rule pr join model m on m.id = pr.model_id where m.provider_id = ${id} order by pr.effective_from desc limit 50`));
		const limits = _rowsOf(await database.execute(sql`select id, scope, scope_id, rpm, tpm, rpd, tpd, concurrency from rate_limit where scope = 'provider' and scope_id = ${id}`));
		const breakers = _rowsOf(await database.execute(sql`select * from circuit_breaker where target = 'provider' and target_id = ${id}`));
		const seeded = _rowsOf(await database.execute(sql`select slug from model where provider_id = ${id}`));
		const totals = _rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(round(percentile_cont(0.5) within group (order by latency_ms)),0)::int as p50, coalesce(round(percentile_cont(0.95) within group (order by latency_ms)),0)::int as p95, coalesce(round(percentile_cont(0.99) within group (order by latency_ms)),0)::int as p99, count(*) filter (where http_status = 429)::int as rate429, count(*) filter (where http_status between 500 and 599)::int as rate5xx, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where provider_id = ${id}`))[0] ?? {};
		const day = _rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where status = 'success')::int as ok, coalesce(round(percentile_cont(0.5) within group (order by latency_ms)),0)::int as p50, coalesce(round(percentile_cont(0.95) within group (order by latency_ms)),0)::int as p95, coalesce(round(percentile_cont(0.99) within group (order by latency_ms)),0)::int as p99, count(*) filter (where http_status = 429)::int as rate429, count(*) filter (where http_status between 500 and 599)::int as rate5xx, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where provider_id = ${id} and created_at > now() - interval '24 hours'`))[0] ?? {};
		const perModel = _rowsOf(await database.execute(sql`select m.slug, count(*)::int as requests, count(*) filter (where r.status = 'success')::int as ok, coalesce(round(percentile_cont(0.5) within group (order by r.latency_ms)),0)::int as p50, coalesce(round(percentile_cont(0.95) within group (order by r.latency_ms)),0)::int as p95 from request_log r join model m on m.id = r.model_id where r.provider_id = ${id} group by m.slug order by count(*) desc limit 12`));
		const errors = _rowsOf(await database.execute(sql`select error_code, http_status, error, count(*)::int as n, max(created_at)::text as last_at from request_log where provider_id = ${id} and status <> 'success' group by error_code, http_status, error order by count(*) desc limit 20`));
		const recent = _rowsOf(await database.execute(sql`select m.slug, r.status, r.http_status, r.latency_ms, r.tokens_in, r.tokens_out, r.error, r.created_at from request_log r left join model m on m.id = r.model_id where r.provider_id = ${id} order by r.created_at desc limit 20`));
		const micro = (v) => String(v ?? '0').split('.')[0];
		return { provider: { id: p.id, name: p.name, slug: p.slug, description: p.description, type: p.type, status: p.status, tier: p.tier, homepage: p.homepage, documentationUrl: p.documentation_url, enabled: p.enabled, baseUrl, priority: p.priority, createdAt: new Date(p.created_at).toISOString() }, allowDev, connections: conns.map((c) => ({ id: c.id, name: c.name, slug: c.slug, baseUrl: c.base_url, region: c.region, authType: c.auth_type, timeoutMs: c.timeout_ms, priority: c.priority, enabled: c.enabled, healthStatus: c.health_status })), credentials: { count: credRows.length, labels: credRows.map((r, i) => ({ label: r.name, index: i, status: r.status, connection: r.conn_name })), healthy, unknown, bad, cooldown }, models: models.map((m) => ({ id: m.id, slug: m.slug, name: m.name, context: m.context, inputPrice: _microToUsd(m.input_price), outputPrice: _microToUsd(m.output_price), status: m.status, inputMicro: micro(m.input_price), outputMicro: micro(m.output_price) })), mappings: mappings.map((m) => ({ id: m.id, providerModelId: m.provider_model_id, modelSlug: m.model_slug, connectionId: m.connection_id, enabled: m.enabled, status: m.status, contextOverride: m.context_override })), pricing: pricing.map((r) => ({ id: r.id, modelSlug: r.model_slug, version: _num(r.version), currency: String(r.currency).trim(), inputPrice: _microToUsd(r.input_price), cachedInputPrice: r.cached_input_price === null ? null : _microToUsd(r.cached_input_price), outputPrice: _microToUsd(r.output_price), reasoningPrice: r.reasoning_price === null ? null : _microToUsd(r.reasoning_price), effectiveFrom: new Date(r.effective_from).toISOString(), effectiveUntil: r.effective_until ? new Date(r.effective_until).toISOString() : null, inputMicro: micro(r.input_price), outputMicro: micro(r.output_price) })), limits, breakers, seededSlugs: seeded.map((s) => s.slug), stats: { totals: { ...totals, cost: String(totals.cost ?? '0'), costMicro: String(totals.cost ?? '0') }, day, perModel: perModel.map((r) => ({ slug: r.slug, requests: _num(r.requests), ok: _num(r.ok), p50: _num(r.p50), p95: _num(r.p95) })), errors: errors.map((r) => ({ errorCode: r.error_code, httpStatus: r.http_status, error: r.error, n: _num(r.n), lastAt: r.last_at })), recent: recent.map((r) => ({ slug: r.slug, status: r.status, httpStatus: r.http_status, latencyMs: r.latency_ms, tokensIn: r.tokens_in, tokensOut: r.tokens_out, error: r.error, createdAt: r.created_at })) }, published: models.filter((m) => m.status === 'active').length, reachable: models.filter((m) => _reach(m.status, p.status, allowDev).served).length };
	}));
	app.post('/api/admin/providers/:id/fetchCatalog', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const tier = String(body.tier ?? 'all').trim();
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${id} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		let cred = {};
		if (conns[0]) { const cr = _rowsOf(await database.execute(sql`select secret_enc from credential where connection_id = ${conns[0].id} order by priority, id limit 1`))[0]; if (cr) { try { cred = _decCred(cr.secret_enc); } catch { _fail(400, 'Connection credential could not be decrypted'); } } }
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		const t0 = Date.now();
		try {
			const catalog = await _fetchCatalog(baseUrl, cred);
			return { fetched: { tier, url: catalog.url, latencyMs: Date.now() - t0, total: catalog.models.length, models: catalog.models, rateLimit: catalog.rateLimit } };
		} catch (err) { console.error(`[admin/providers/${id}/fetchCatalog] upstream fetch failed`, err); _fail(502, 'upstream request failed'); }
	}));
	app.post('/api/admin/providers/:id/enable', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const payloads = Array.isArray(body.payload) ? body.payload : (body.payload ? [body.payload] : []);
		const clean = [];
		for (const raw of payloads.slice(0, MAX_BATCH_MODELS)) {
			try {
				const e = typeof raw === 'string' ? JSON.parse(raw) : raw;
				const slug = _parseSlug(e.slug); if (!slug) continue;
				clean.push({ slug, name: String(e.name ?? slug).slice(0, 200) || slug, context: null, inputUsd: String(e.inputUsd ?? '0'), outputUsd: String(e.outputUsd ?? '0') });
			} catch {}
		}
		const known = new Map(_rowsOf(await database.execute(sql`select id, provider_id, slug, status from model`)).map((m) => [_matchKey(m.slug), m]));
		let added = 0, published = 0; const skipped = [];
		for (const row of clean) {
			const input = _usdToMicro(row.inputUsd) ?? '0'; const output = _usdToMicro(row.outputUsd) ?? '0';
			const existing = known.get(_matchKey(row.slug));
			if (!existing) {
				try {
					await database.transaction(async (tx) => {
						const nid = _newId(_IDP.model);
						await tx.execute(sql`insert into model (id, provider_id, name, slug, input_price, output_price, status) values (${nid}, ${id}, ${row.name}, ${row.slug}, ${input}, ${output}, 'active')`);
						await _audit(tx, { actorUserId: userRow.id, action: 'model.create', resource: 'model', resourceId: nid, after: { slug: row.slug, name: row.name, providerId: id, inputPrice: input, outputPrice: output } });
					});
					added += 1;
				} catch { skipped.push(row.slug); }
				continue;
			}
			if (existing.provider_id !== id) { skipped.push(row.slug); continue; }
			await database.transaction(async (tx) => {
				await tx.execute(sql`update model set status = 'active' where id = ${existing.id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'model.publish', resource: 'model', resourceId: existing.id, before: { status: existing.status }, after: { status: 'active' } });
			});
			published += 1;
		}
		return { message: `Enable: ${added} added, ${published} published${skipped.length ? `, ${skipped.length} skipped (owned elsewhere): ${skipped.slice(0, 5).join(', ')}` : ''}.` };
	}));
	app.post('/api/admin/providers/:id/disable', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const rawSlugs = Array.isArray(body.slug) ? body.slug : (body.slug ? [body.slug] : []);
		const slugs = [...new Set(rawSlugs.map((s) => String(s)).filter(Boolean).slice(0, MAX_BATCH_MODELS))];
		if (!slugs.length) _fail(400, 'Select at least one model');
		const forms = [...new Set([...slugs, ...slugs.map(_matchKey)])];
		const updated = await database.transaction(async (tx) => {
			const rows = _rowsOf(await tx.execute(sql`update model set status = 'disabled' where provider_id = ${id} and slug in (${sql.join(forms.map((s) => sql`${s}`), sql`, `)}) returning id, slug`));
			for (const r of rows) await _audit(tx, { actorUserId: userRow.id, action: 'model.disable', resource: 'model', resourceId: r.id, before: { status: 'active' }, after: { status: 'disabled' } });
			return rows;
		});
		return { message: `Disabled ${updated.length} model(s).` };
	}));
	app.post('/api/admin/providers/:id/testCredential', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${id} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		const creds = conns[0] ? _rowsOf(await database.execute(sql`select id, name, secret_enc from credential where connection_id = ${conns[0].id} order by priority, id`)) : [];
		const index = Number(String(body.index ?? '').trim());
		if (!Number.isInteger(index) || index < 0 || index >= creds.length) _fail(400, 'Pick a credential that exists');
		const row = creds[index];
		let cred; try { cred = _decCred(row.secret_enc); } catch { _fail(400, 'Cannot decrypt credentials'); }
		const t0 = Date.now();
		try {
			const r = await _fetchCatalog(baseUrl, cred);
			return { credentialTest: { label: row.name, index, ok: r.status === 200, status: r.status, latencyMs: Date.now() - t0, modelCount: r.models.length, rateLimit: r.rateLimit, error: null } };
		} catch (err) { console.error(`[admin/providers/${id}/testCredential] upstream fetch failed`, err); return { credentialTest: { label: row.name, index, ok: false, status: null, latencyMs: Date.now() - t0, modelCount: 0, rateLimit: {}, error: 'upstream request failed' } }; }
	}));
	app.post('/api/admin/providers/:id/testAll', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${id} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		const creds = conns[0] ? _rowsOf(await database.execute(sql`select id, name, secret_enc from credential where connection_id = ${conns[0].id} order by priority, id`)) : [];
		const probes = creds.slice(0, MAX_BULK_TEST).map((row, index) => ({ label: row.name, index, enc: row.secret_enc }));
		const results = await Promise.all(probes.map(async ({ label, index, enc }) => {
			const t0 = Date.now();
			let cred; try { cred = _decCred(enc); } catch { return { label, index, ok: false, status: null, latencyMs: 0, modelCount: 0, rateLimit: {}, error: 'cannot decrypt credentials' }; }
			try { const r = await _fetchCatalog(baseUrl, cred); return { label, index, ok: r.status === 200, status: r.status, latencyMs: Date.now() - t0, modelCount: r.models.length, rateLimit: r.rateLimit, error: null }; }
			catch (err) { console.error(`[admin/providers/${id}/testAll] upstream fetch failed`, err); return { label, index, ok: false, status: null, latencyMs: Date.now() - t0, modelCount: 0, rateLimit: {}, error: 'upstream request failed' }; }
		}));
		return { credentialTests: results, bulkNote: creds.length > MAX_BULK_TEST ? `Tested the first ${MAX_BULK_TEST} of ${creds.length} credentials.` : null };
	}));
	app.post('/api/admin/providers/:id/testModel', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const slug = String(body.slug ?? '').trim().slice(0, 200);
		if (!slug) _fail(400, 'Missing or malformed model slug');
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${id} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		const cr = conns[0] ? _rowsOf(await database.execute(sql`select secret_enc from credential where connection_id = ${conns[0].id} order by priority, id limit 1`))[0] : null;
		if (!cr) _fail(400, 'No credential to probe with');
		let cred; try { cred = _decCred(cr.secret_enc); } catch { _fail(400, 'Cannot decrypt credentials'); }
		const headers = { ..._headersFor(cred, _tokenAt(cred, 0)), 'content-type': 'application/json' };
		const t0 = Date.now();
		try {
			const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
			let res; try { res = await fetch(`${String(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }), signal: ctrl.signal, redirect: 'manual' }); } finally { clearTimeout(t); }
			if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) { console.error(`[admin/providers/${id}/testModel] upstream returned a redirect, which is not followed`); return { modelTest: { ok: false, status: res.status, latencyMs: Date.now() - t0, tokensIn: null, tokensOut: null, content: null, reasoning: null, finishReason: null, error: 'upstream returned a redirect, which is not followed', slug } }; }
			const data = await res.json().catch(() => null);
			const choice = data?.choices?.[0];
			return { modelTest: { ok: res.ok, status: res.status, latencyMs: Date.now() - t0, tokensIn: data?.usage?.prompt_tokens ?? null, tokensOut: data?.usage?.completion_tokens ?? null, content: choice?.message?.content ?? null, reasoning: choice?.message?.reasoning_content ?? null, finishReason: choice?.finish_reason ?? null, error: res.ok ? null : `HTTP ${res.status}`, slug } };
		} catch (err) { console.error(`[admin/providers/${id}/testModel] upstream fetch failed`, err); return { modelTest: { ok: false, status: null, latencyMs: Date.now() - t0, error: 'upstream request failed', slug } }; }
	}));
	app.post('/api/admin/providers/:id/chat', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const slug = String(body.slug ?? '').trim().slice(0, 200);
		const message = String(body.message ?? '').trim().slice(0, MAX_CHAT_CHARS);
		if (!slug) _fail(400, 'Pick a model');
		if (!message) _fail(400, `Type a message (up to ${MAX_CHAT_CHARS} characters)`);
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${id} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const conns = _rowsOf(await database.execute(sql`select id, base_url from connection where provider_id = ${id} order by priority, id limit 1`));
		const baseUrl = conns[0]?.base_url ?? null;
		if (!baseUrl) _fail(400, 'Add a connection with a base URL first');
		const guard = await _assertPublic(baseUrl, _allowPrivate());
		if (!guard.ok) _fail(400, guard.reason);
		const cr = conns[0] ? _rowsOf(await database.execute(sql`select secret_enc from credential where connection_id = ${conns[0].id} order by priority, id limit 1`))[0] : null;
		if (!cr) _fail(400, 'No credential to probe with');
		let cred; try { cred = _decCred(cr.secret_enc); } catch { _fail(400, 'Cannot decrypt credentials'); }
		const headers = { ..._headersFor(cred, _tokenAt(cred, 0)), 'content-type': 'application/json' };
		const t0 = Date.now();
		try {
			const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
			let res; try { res = await fetch(`${String(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: message }], max_tokens: 512 }), signal: ctrl.signal, redirect: 'manual' }); } finally { clearTimeout(t); }
			if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) { console.error(`[admin/providers/${id}/chat] upstream returned a redirect, which is not followed`); return { chat: { ok: false, status: res.status, latencyMs: Date.now() - t0, tokensIn: null, tokensOut: null, content: null, reasoning: null, finishReason: null, error: 'upstream returned a redirect, which is not followed', slug, message } }; }
			const data = await res.json().catch(() => null);
			const choice = data?.choices?.[0];
			return { chat: { ok: res.ok, status: res.status, latencyMs: Date.now() - t0, tokensIn: data?.usage?.prompt_tokens ?? null, tokensOut: data?.usage?.completion_tokens ?? null, content: choice?.message?.content ?? null, reasoning: choice?.message?.reasoning_content ?? null, finishReason: choice?.finish_reason ?? null, error: res.ok ? null : `HTTP ${res.status}`, slug, message } };
		} catch (err) { console.error(`[admin/providers/${id}/chat] upstream fetch failed`, err); return { chat: { ok: false, status: null, latencyMs: Date.now() - t0, error: 'upstream request failed', slug, message } }; }
	}));
	app.post('/api/admin/providers/:id/strategy', poster('providers', async (database, body, userRow, req) => {
		const id = String(req.params?.id ?? body.providerId ?? '').trim();
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		if (priority === null) _fail(400, `Priority must be a whole number between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
		const before = _rowsOf(await database.execute(sql`select id, priority from provider where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Provider not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update provider set priority = ${priority} where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'provider.update', resource: 'provider', resourceId: id, before: { priority: before.priority }, after: { priority } });
		});
		return { message: `Priority set to ${priority}.` };
	}));

	// Provider connections (admin/providers/[id]/connections): GET + create/update/delete.
	const _connPatch = (body) => {
		const name = _cleanField(body.name);
		const slug = _parseSlug(body.slug);
		const baseUrl = _cleanField(body.baseUrl, 2000);
		const region = body.region ? _cleanField(body.region) : null;
		const authType = _parseEnum(CONNECTION_AUTH_TYPES, body.authType);
		const timeoutMs = _parseInt(body.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		const config = _parseJson(body.config);
		if (!name || !slug || !baseUrl || !authType || timeoutMs === null || priority === null) return { error: 'Name, slug, base URL, auth type, timeout and priority are all required' };
		if (config === null) return { error: 'Config must be a JSON object' };
		return { values: { name, slug, baseUrl, region, authType, timeoutMs, priority, enabled: _parseBool(body.enabled), config } };
	};
	app.post('/api/admin/providers/:id/connections/create', poster('providers', async (database, body, userRow, req) => {
		const pid = String(req.params?.id ?? body.providerId ?? '').trim();
		const v = _connPatch(body);
		if (v.error) _fail(400, v.error);
		const guard = await _assertPublic(v.values.baseUrl);
		if (!guard.ok) _fail(400, guard.reason);
		const p = _rowsOf(await database.execute(sql`select id from provider where id = ${pid} limit 1`))[0];
		if (!p) _fail(404, 'Provider not found');
		const dup = _rowsOf(await database.execute(sql`select id from connection where provider_id = ${pid} and slug = ${v.values.slug} limit 1`));
		if (dup.length) _fail(400, 'A connection with this slug already exists');
		const id = _newId(_IDP.connection);
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into connection (id, provider_id, name, slug, base_url, region, auth_type, timeout_ms, priority, enabled, config) values (${id}, ${pid}, ${v.values.name}, ${v.values.slug}, ${v.values.baseUrl}, ${v.values.region}, ${v.values.authType}, ${v.values.timeoutMs}, ${v.values.priority}, ${v.values.enabled}, ${JSON.stringify(v.values.config)}::jsonb)`);
			await _audit(tx, { actorUserId: userRow.id, action: 'connection.create', resource: 'connection', resourceId: id, after: v.values });
		});
		return { created: v.values.name };
	}));
	app.post('/api/admin/providers/connections/update', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing connection id');
		const v = _connPatch(body);
		if (v.error) _fail(400, v.error);
		const guard = await _assertPublic(v.values.baseUrl);
		if (!guard.ok) _fail(400, guard.reason);
		const before = _rowsOf(await database.execute(sql`select * from connection where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Connection not found');
		const dup = _rowsOf(await database.execute(sql`select id from connection where provider_id = ${before.provider_id} and slug = ${v.values.slug} limit 1`))[0];
		if (dup && dup.id !== id) _fail(400, 'A connection with this slug already exists');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update connection set name = ${v.values.name}, slug = ${v.values.slug}, base_url = ${v.values.baseUrl}, region = ${v.values.region}, auth_type = ${v.values.authType}, timeout_ms = ${v.values.timeoutMs}, priority = ${v.values.priority}, enabled = ${v.values.enabled}, config = ${JSON.stringify(v.values.config)}::jsonb, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'connection.update', resource: 'connection', resourceId: id, before: { name: before.name, slug: before.slug }, after: v.values });
		});
		return { updated: id };
	}));
	app.post('/api/admin/providers/connections/delete', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing connection id');
		const before = _rowsOf(await database.execute(sql`select id, name from connection where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Connection not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from connection where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'connection.delete', resource: 'connection', resourceId: id, before });
		});
		return { deleted: id };
	}));
	// Provider credentials (admin/providers/[id]/credentials): GET + create/update/disable/enable/rotate/revoke/delete.
	const _secretBlob = (apiKey, headersText) => {
		const headers = {};
		for (const line of String(headersText ?? '').split('\n')) {
			const i = line.indexOf(':');
			if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim(); if (k && v) headers[k] = v; }
		}
		const payload = { api_key: apiKey };
		if (Object.keys(headers).length) payload.default_headers = headers;
		return _encCred(payload);
	};
	app.post('/api/admin/providers/credentials/create', poster('providers', async (database, body, userRow, req) => {
		const pid = String(req.params?.id ?? body.providerId ?? '').trim();
		const name = _cleanField(body.name);
		const secret = String(body.secret ?? '').trim();
		const headers = String(body.headers ?? '');
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		const weight = _parseInt(body.weight, 0, 10000);
		const metadata = _parseJson(body.metadata);
		const connectionId = String(body.connectionId ?? '').trim();
		if (!name || !secret || !connectionId || priority === null || weight === null) _fail(400, 'Name, connection, secret, priority and weight are all required');
		if (metadata === null) _fail(400, 'Metadata must be a JSON object');
		const conn = _rowsOf(await database.execute(sql`select c.id from connection c join provider p on p.id = c.provider_id where p.id = ${pid} and c.id = ${connectionId} limit 1`))[0];
		if (!conn && pid) { const c2 = _rowsOf(await database.execute(sql`select id from connection where id = ${connectionId} limit 1`))[0]; if (!c2) _fail(404, 'Connection not found on this provider'); }
		else if (!conn) _fail(404, 'Connection not found on this provider');
		const id = _newId(_IDP.credential);
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into credential (id, connection_id, name, secret_enc, status, priority, weight, metadata) values (${id}, ${connectionId}, ${name}, ${_secretBlob(secret, headers)}, 'unknown', ${priority}, ${weight}, ${JSON.stringify(metadata)}::jsonb)`);
			await _audit(tx, { actorUserId: userRow.id, action: 'credential.create', resource: 'credential', resourceId: id, after: { name, connectionId, priority, weight, metadata } });
		});
		return { created: true, secretOnce: { shownOnce: true, id, name, secret } };
	}));
	app.post('/api/admin/providers/credentials/update', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const name = _cleanField(body.name);
		const priority = _parseInt(body.priority, MIN_PRIORITY, MAX_PRIORITY);
		const weight = _parseInt(body.weight, 0, 10000);
		const metadata = _parseJson(body.metadata);
		const status = String(body.status ?? '').trim();
		if (!id) _fail(400, 'Missing credential id');
		if (!name || priority === null || weight === null) _fail(400, 'Name, priority and weight are all required');
		if (metadata === null) _fail(400, 'Metadata must be a JSON object');
		if (status && !CREDENTIAL_STATUSES.includes(status)) _fail(400, 'Invalid status');
		const before = _rowsOf(await database.execute(sql`select * from credential where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Credential not found');
		await database.transaction(async (tx) => {
			if (status) await tx.execute(sql`update credential set name = ${name}, priority = ${priority}, weight = ${weight}, metadata = ${JSON.stringify(metadata)}::jsonb, status = ${status}, updated_at = now() where id = ${id}`);
			else await tx.execute(sql`update credential set name = ${name}, priority = ${priority}, weight = ${weight}, metadata = ${JSON.stringify(metadata)}::jsonb, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'credential.update', resource: 'credential', resourceId: id, before: { name: before.name, priority: before.priority, weight: before.weight, status: before.status, metadata: before.metadata }, after: { name, priority, weight, metadata, ...(status ? { status } : {}) } });
		});
		return { updated: id };
	}));
	const _credSetStatus = async (database, body, userRow, status, action) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing credential id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Tick the confirmation box');
		const before = _rowsOf(await database.execute(sql`select id, status from credential where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Credential not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update credential set status = ${status}, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action, resource: 'credential', resourceId: id, before: { status: before.status }, after: { status } });
		});
		return { updated: id };
	};
	app.post('/api/admin/providers/credentials/disable', poster('providers', (database, body, userRow) => _credSetStatus(database, body, userRow, 'disabled', 'credential.disable')));
	app.post('/api/admin/providers/credentials/enable', poster('providers', (database, body, userRow) => _credSetStatus(database, body, userRow, 'unknown', 'credential.enable')));
	app.post('/api/admin/providers/credentials/rotate', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const secret = String(body.secret ?? '').trim();
		const headers = String(body.headers ?? '');
		if (!id) _fail(400, 'Missing credential id');
		if (!secret) _fail(400, 'A rotation needs the new secret');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Tick the confirmation box to rotate');
		const before = _rowsOf(await database.execute(sql`select id, name, status from credential where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Credential not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update credential set secret_enc = ${_secretBlob(secret, headers)}, status = 'unknown', cooldown_until = null, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'credential.rotate', resource: 'credential', resourceId: id, before: { status: before.status }, after: { status: 'unknown', cooldownUntil: null } });
		});
		return { rotated: true, secretOnce: { shownOnce: true, id, name: before.name, secret } };
	}));
	app.post('/api/admin/providers/credentials/revoke', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing credential id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Tick the confirmation box to revoke');
		const before = _rowsOf(await database.execute(sql`select id, status from credential where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Credential not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update credential set status = 'invalid', cooldown_until = null, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'credential.revoke', resource: 'credential', resourceId: id, before: { status: before.status }, after: { status: 'invalid', cooldownUntil: null } });
		});
		return { revoked: id };
	}));
	app.post('/api/admin/providers/credentials/delete', poster('providers', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing credential id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Tick the confirmation box to delete');
		const before = _rowsOf(await database.execute(sql`select id, name, connection_id, status from credential where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Credential not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from credential where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'credential.delete', resource: 'credential', resourceId: id, before });
		});
		return { deleted: id };
	}));
	// Request detail (admin/requests/[id]): detail + bodies + attempts + timing.
	app.get('/api/admin/requests/:id', handler('requests', async (database, url) => {
		const id = String(url.pathname.split('/').pop());
		const row = _rowsOf(await database.execute(sql`select r.id, r.created_at, u.email, k.name as key_name, k.prefix as key_prefix, r.workspace_id, r.project_id, r.environment_id, r.endpoint, r.requested_model, m.slug as model_slug, r.provider_model_id, pm.provider_model_id as upstream_model_id, p.name as provider_name, c.name as connection_name, r.credential_id, r.routing_policy_id, r.strategy, r.status, r.error_code, r.error, r.http_status, r.tokens_in, r.cached_input_tokens, r.tokens_out, r.reasoning_tokens, r.total_tokens, r.input_price_micro, r.cached_input_price_micro, r.output_price_micro, r.reasoning_price_micro, r.pricing_rule_id, r.cost, r.currency, r.credit_charged_micro, r.provider_cost_micro, r.timing, r.ttft_ms, r.latency_ms, r.attempts, r.fallback_used, r.stream, r.client_disconnected, r.request_body, r.response_body from request_log r left join "user" u on u.id = r.user_id left join api_key k on k.id = r.api_key_id left join model m on m.id = r.model_id left join provider_model pm on pm.id = r.provider_model_id left join provider p on p.id = r.provider_id left join connection c on c.id = r.connection_id where r.id = ${id} limit 1`))[0];
		if (!row) { const e = new ctx.HttpError(404, 'Request not found'); throw e; }
		const attempts = _rowsOf(await database.execute(sql`select a.id, a.attempt, p.name as provider_name, c.name as connection_name, a.credential_id, a.http_status, a.error_code, a.retryable, a.latency_ms, a.ttft_ms, a.provider_cost_micro, a.reason, a.started_at, a.finished_at from request_attempt a left join provider p on p.id = a.provider_id left join connection c on c.id = a.connection_id where a.request_id = ${id} order by a.attempt`));
		const retention = await _getSetting(database, 'retention');
		const contentOk = retention && typeof retention.request_content_days === 'number' && retention.request_content_days > 0;
		const { request_body: _rq, response_body: _rs, ...detail } = row;
		return { detail, bodies: { requestBody: contentOk ? (row.request_body ?? null) : null, responseBody: contentOk ? (row.response_body ?? null) : null, contentRetained: !!contentOk }, attempts, timing: TIMING_KEYS.map((key) => ({ key, ms: row.timing?.[key] ?? null })) };
	}));

	// ---- parity block: routing ----
	// Circuit breakers (admin/routing/circuit-breakers): GET + create/update/delete.
	app.get('/api/admin/routing/circuit-breakers', handler('routing', async (database) => {
		const rows = _rowsOf(await database.execute(sql`select * from circuit_breaker order by target, target_id`));
		const providers = _rowsOf(await database.execute(sql`select id, name from provider order by name`));
		const connections = _rowsOf(await database.execute(sql`select id, name, provider_id from connection order by name`));
		const models = _rowsOf(await database.execute(sql`select id, name, slug from model order by slug`));
		let states = rows.map(() => null);
		if (process.env.VALKEY_URL) {
			try {
				const send = (cmd) => _vkSend(cmd, 3000);
				states = await Promise.all(rows.map(async (r) => {
					try {
						const key = `circuit:${r.target}:${r.target_id}`;
						const raw = await send(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
						const i = raw.indexOf('\r\n');
						const n = parseInt(raw.slice(1, i), 10);
						if (Number.isNaN(n) || n < 0) return null;
						return raw.slice(i + 2, i + 2 + n);
					} catch { return null; }
				}));
			} catch {}
		}
		return { breakers: rows.map((r, i) => ({ ...r, state: states[i] === null ? 'closed (or unavailable)' : states[i] })), providers, connections, models, targets: CIRCUIT_TARGETS };
	}));
	const _breakerPatch = (body) => {
		const failureThreshold = _parseInt(body.failureThreshold, 1, 1000);
		if (failureThreshold === null) return { error: 'failure_threshold must be 1–1000' };
		const windowSeconds = _parseInt(body.windowSeconds, 1, 86400);
		if (windowSeconds === null) return { error: 'window_seconds must be 1–86400' };
		const openMs = _parseInt(body.openMs, 1, 86400000);
		if (openMs === null) return { error: 'open_ms must be 1–86400000' };
		const halfOpenProbes = _parseInt(body.halfOpenProbes, 1, 100);
		if (halfOpenProbes === null) return { error: 'half_open_probes must be 1–100' };
		return { values: { failureThreshold, windowSeconds, openMs, halfOpenProbes, enabled: _parseBool(body.enabled) } };
	};
	const _resolveTarget = async (database, body) => {
		const target = _parseEnum(CIRCUIT_TARGETS, body.target);
		const targetId = String(body.targetId ?? '').trim();
		if (!target || !targetId) return null;
		const tbl = target === 'provider' ? 'provider' : target === 'connection' ? 'connection' : 'model';
		const hit = _rowsOf(await database.execute(sql`select id from ${sql.raw(tbl)} where id = ${targetId} limit 1`));
		return hit.length ? { target, targetId: hit[0].id } : null;
	};
	app.post('/api/admin/routing/circuit-breakers/create', poster('routing', async (database, body, userRow) => {
		const t = await _resolveTarget(database, body);
		if (!t) _fail(400, 'Target must name a real provider, connection or model');
		const v = _breakerPatch(body);
		if (v.error) _fail(400, v.error);
		const dup = _rowsOf(await database.execute(sql`select id from circuit_breaker where target = ${t.target} and target_id = ${t.targetId} limit 1`));
		if (dup.length) _fail(400, 'A breaker for this target already exists');
		const id = _newId(_IDP.circuitBreaker);
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into circuit_breaker (id, target, target_id, failure_threshold, window_seconds, open_ms, half_open_probes, enabled) values (${id}, ${t.target}, ${t.targetId}, ${v.values.failureThreshold}, ${v.values.windowSeconds}, ${v.values.openMs}, ${v.values.halfOpenProbes}, ${v.values.enabled})`);
			await _audit(tx, { actorUserId: userRow.id, action: 'circuit_breaker.create', resource: 'circuit_breaker', resourceId: id, after: { ...t, ...v.values } });
		});
		return { created: id };
	}));
	app.post('/api/admin/routing/circuit-breakers/update', poster('routing', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing breaker id');
		const v = _breakerPatch(body);
		if (v.error) _fail(400, v.error);
		const before = _rowsOf(await database.execute(sql`select * from circuit_breaker where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Breaker not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update circuit_breaker set failure_threshold = ${v.values.failureThreshold}, window_seconds = ${v.values.windowSeconds}, open_ms = ${v.values.openMs}, half_open_probes = ${v.values.halfOpenProbes}, enabled = ${v.values.enabled} where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'circuit_breaker.update', resource: 'circuit_breaker', resourceId: id, before: { failureThreshold: before.failure_threshold, windowSeconds: before.window_seconds }, after: v.values });
		});
		return { updated: id };
	}));
	app.post('/api/admin/routing/circuit-breakers/delete', poster('routing', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing breaker id');
		const before = _rowsOf(await database.execute(sql`select id from circuit_breaker where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Breaker not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from circuit_breaker where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'circuit_breaker.delete', resource: 'circuit_breaker', resourceId: id, before: { id } });
		});
		return { deleted: id };
	}));
	// Fallbacks (admin/routing/fallbacks): read-only GET.
	app.get('/api/admin/routing/fallbacks', handler('routing', async (database) => {
		const policies = _rowsOf(await database.execute(sql`select id, name, max_attempts, fallback_enabled, enabled from routing_policy order by name`));
		return { policies: policies.map((p) => ({ id: p.id, name: p.name, maxAttempts: p.max_attempts, fallbackEnabled: p.fallback_enabled, enabled: p.enabled })), retryable: RETRYABLE_CODES, neverRetry: NEVER_RETRY_CODES };
	}));
	// Policies (admin/routing/policies): GET + create/update/delete.
	app.get('/api/admin/routing/policies', handler('routing', async (database) => {
		const policies = _rowsOf(await database.execute(sql`select * from routing_policy order by name`));
		const workspaces = _rowsOf(await database.execute(sql`select id, name from workspace order by name`));
		const projects = _rowsOf(await database.execute(sql`select id, name from project order by name`));
		const envs = _rowsOf(await database.execute(sql`select id, name, project_id from environment order by name`));
		return { policies, workspaces, projects, environments: envs.map((e) => ({ id: e.id, name: e.name, projectId: e.project_id })), strategies: SIM_STRATEGIES, scopes: POLICY_SCOPES };
	}));
	const _policyPatch = (body) => {
		const name = _cleanField(body.name);
		if (!name) return { error: 'Name is required' };
		const strategy = _parseEnum(SIM_STRATEGIES, body.strategy);
		if (!strategy) return { error: 'Invalid strategy' };
		const maxAttempts = _parseInt(body.maxAttempts, 1, 10);
		if (maxAttempts === null) return { error: 'max_attempts must be 1–10' };
		const requestTimeoutMs = _parseInt(body.requestTimeoutMs, 1, 600000);
		if (requestTimeoutMs === null) return { error: 'request_timeout_ms must be 1–600000' };
		for (const k of ['providerPreferences', 'modelPreferences', 'constraints', 'weights']) { if (_parseJson(body[k]) === null) return { error: `${k} must be a JSON object` }; }
		return { values: { name, strategy, enabled: _parseBool(body.enabled), maxAttempts, requestTimeoutMs, fallbackEnabled: _parseBool(body.fallbackEnabled), providerPreferences: _parseJson(body.providerPreferences), modelPreferences: _parseJson(body.modelPreferences), constraints: _parseJson(body.constraints), weights: _parseJson(body.weights) } };
	};
	const _resolveScope = async (database, body) => {
		const scope = _parseEnum(POLICY_SCOPES, body.scope);
		const scopeId = String(body.scopeId ?? '').trim();
		if (scope === 'platform' || (!scope && !scopeId)) return { workspaceId: null, projectId: null, environmentId: null };
		if (!scope || !scopeId) return null;
		const tbl = scope === 'workspace' ? 'workspace' : scope === 'project' ? 'project' : 'environment';
		const hit = _rowsOf(await database.execute(sql`select id from ${sql.raw(tbl)} where id = ${scopeId} limit 1`));
		if (!hit.length) return null;
		return { workspaceId: scope === 'workspace' ? hit[0].id : null, projectId: scope === 'project' ? hit[0].id : null, environmentId: scope === 'environment' ? hit[0].id : null };
	};
	app.post('/api/admin/routing/policies/create', poster('routing', async (database, body, userRow) => {
		const v = _policyPatch(body);
		if (v.error) _fail(400, v.error);
		const s = await _resolveScope(database, body);
		if (!s) _fail(400, 'Invalid scope');
		const id = _newId(_IDP.routingPolicy);
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into routing_policy (id, workspace_id, project_id, environment_id, name, strategy, enabled, max_attempts, request_timeout_ms, fallback_enabled, provider_preferences, model_preferences, constraints, weights) values (${id}, ${s.workspaceId}, ${s.projectId}, ${s.environmentId}, ${v.values.name}, ${v.values.strategy}, ${v.values.enabled}, ${v.values.maxAttempts}, ${v.values.requestTimeoutMs}, ${v.values.fallbackEnabled}, ${JSON.stringify(v.values.providerPreferences)}::jsonb, ${JSON.stringify(v.values.modelPreferences)}::jsonb, ${JSON.stringify(v.values.constraints)}::jsonb, ${JSON.stringify(v.values.weights)}::jsonb)`);
			await _audit(tx, { actorUserId: userRow.id, action: 'routing_policy.create', resource: 'routing_policy', resourceId: id, after: { ...v.values, ...s } });
		});
		return { created: id };
	}));
	app.post('/api/admin/routing/policies/update', poster('routing', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing policy id');
		const v = _policyPatch(body);
		if (v.error) _fail(400, v.error);
		const s = await _resolveScope(database, body);
		if (!s) _fail(400, 'Invalid scope');
		const before = _rowsOf(await database.execute(sql`select * from routing_policy where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Policy not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update routing_policy set workspace_id = ${s.workspaceId}, project_id = ${s.projectId}, environment_id = ${s.environmentId}, name = ${v.values.name}, strategy = ${v.values.strategy}, enabled = ${v.values.enabled}, max_attempts = ${v.values.maxAttempts}, request_timeout_ms = ${v.values.requestTimeoutMs}, fallback_enabled = ${v.values.fallbackEnabled}, provider_preferences = ${JSON.stringify(v.values.providerPreferences)}::jsonb, model_preferences = ${JSON.stringify(v.values.modelPreferences)}::jsonb, constraints = ${JSON.stringify(v.values.constraints)}::jsonb, weights = ${JSON.stringify(v.values.weights)}::jsonb, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'routing_policy.update', resource: 'routing_policy', resourceId: id, before: { name: before.name, strategy: before.strategy }, after: { ...v.values, ...s } });
		});
		return { updated: id };
	}));
	app.post('/api/admin/routing/policies/delete', poster('routing', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing policy id');
		const before = _rowsOf(await database.execute(sql`select id, name from routing_policy where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Policy not found');
		const refs = _rowsOf(await database.execute(sql`select id from environment where routing_policy_id = ${id} limit 1`));
		if (refs.length) _fail(409, 'Policy is referenced by an environment');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update environment set routing_policy_id = null where routing_policy_id = ${id}`);
			await tx.execute(sql`delete from routing_policy where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'routing_policy.delete', resource: 'routing_policy', resourceId: id, before });
		});
		return { deleted: id };
	}));
	// Strategies (admin/routing/strategies): read-only GET.
	app.get('/api/admin/routing/strategies', handler('routing', async (database) => {
		const policies = _rowsOf(await database.execute(sql`select id, name, strategy, weights from routing_policy order by name`));
		return { strategies: SIM_STRATEGIES.map((s) => ({ key: s, uses: STRATEGY_USES[s] ?? '' })), policies };
	}));
	// Simulations (admin/routing/simulations): GET + simulate.
	app.get('/api/admin/routing/simulations', handler('routing', async (database) => {
		const models = _rowsOf(await database.execute(sql`select id, name, slug, status from model order by slug`));
		const projects = _rowsOf(await database.execute(sql`select id, name from project order by name`));
		return { models, projects, strategies: SIM_STRATEGIES };
	}));
	app.post('/api/admin/routing/simulations/simulate', poster('routing', async (database, body) => {
		const modelId = String(body.modelId ?? '').trim();
		if (!modelId) _fail(400, 'Pick a model');
		const strategy = _parseEnum(SIM_STRATEGIES, body.strategy);
		if (!strategy) _fail(400, 'Invalid strategy');
		const inputTokens = _parseInt(body.inputTokens, 0, 10000000);
		if (inputTokens === null) _fail(400, 'input token estimate must be 0–10000000');
		const outputTokens = _parseInt(body.outputTokens, 0, 10000000);
		if (outputTokens === null) _fail(400, 'output token estimate must be 0–10000000');
		const w = (raw) => { const v = String(raw ?? '').trim(); if (!v) return undefined; const n = Number(v); return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : undefined; };
		const weights = { price: w(body.weightPrice), latency: w(body.weightLatency), reliability: w(body.weightReliability), capacity: w(body.weightCapacity) };
		const region = String(body.region ?? '').trim().slice(0, 40) || null;
		const projectId = String(body.projectId ?? '').trim().slice(0, 64) || null;
		const cands = _rowsOf(await database.execute(sql`select p.id as provider_id, p.name as provider_name, p.priority as provider_priority, c.id as connection_id, c.name as connection_name, pm.id as pm_id, pm.enabled as pm_enabled, c.health_status, (select jsonb_build_object('input', pr.input_price::text, 'output', pr.output_price::text) from pricing_rule pr where pr.provider_model_id = pm.id and pr.effective_from <= now() and (pr.effective_until is null or pr.effective_until > now()) order by pr.version desc limit 1) as specific_price, (select jsonb_build_object('input', pr.input_price::text, 'output', pr.output_price::text) from pricing_rule pr where pr.model_id = ${modelId} and pr.provider_model_id is null and pr.effective_from <= now() and (pr.effective_until is null or pr.effective_until > now()) order by pr.version desc limit 1) as wide_price, m.input_price::text as legacy_input, m.output_price::text as legacy_output from provider_model pm join model m on m.id = pm.model_id join provider p on p.id = pm.provider_id left join connection c on c.id = pm.connection_id where pm.model_id = ${modelId} order by p.priority, p.name`));
		const ids = cands.map((c) => c.pm_id);
		let stats = new Map();
		if (ids.length) {
			const s = _rowsOf(await database.execute(sql`select provider_model_id as pm_id, count(*) filter (where status = 'success')::int as successes, count(*)::int as total, (percentile_cont(0.95) within group (order by latency_ms))::int as p95 from request_log where provider_model_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) group by provider_model_id`));
			stats = new Map(s.map((r) => [r.pm_id, r]));
		}
		const num = (t) => { const m = /^-?\d+/.exec(String(t ?? '').trim()); return m ? BigInt(m[0]) : 0n; };
		const scored = cands.map((c) => {
			const rule = c.specific_price ?? c.wide_price;
			const inp = rule?.input != null ? num(rule.input) : num(c.legacy_input);
			const outp = rule?.output != null ? num(rule.output) : num(c.legacy_output);
			const cost = (BigInt(Math.max(0, inputTokens)) * inp + BigInt(Math.max(0, outputTokens)) * outp) / 1000000n;
			const st = stats.get(c.pm_id);
			const total = _num(st?.total);
			return { providerId: c.provider_id, providerName: c.provider_name, providerPriority: _num(c.provider_priority), connectionId: c.connection_id, connectionName: c.connection_name, providerModelId: c.pm_id, estimatedCostMicro: cost < 0n ? 0n : cost, healthStatus: c.health_status ?? 'unknown', availability: total > 0 ? Math.min(1, Math.max(0, _num(st?.successes) / total)) : 1, p95LatencyMs: st?.p95 ?? 0, enabled: !!c.pm_enabled };
		});
		const norm = (vals, invert) => { const mn = Math.min(...vals); const mx = Math.max(...vals); if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx === mn) return vals.map(() => 1); return vals.map((v) => { const n = (v - mn) / (mx - mn); return invert ? 1 - n : n; }); };
		const costS = norm(scored.map((c) => Number(c.estimatedCostMicro)), true);
		const latS = norm(scored.map((c) => c.p95LatencyMs), true);
		const avS = norm(scored.map((c) => c.availability), false);
		const priS = norm(scored.map((c) => c.providerPriority), true);
		const dw = { price: 0.4, latency: 0.3, reliability: 0.2, capacity: 0.1 };
		const W = { price: weights.price ?? dw.price, latency: weights.latency ?? dw.latency, reliability: weights.reliability ?? dw.reliability, capacity: weights.capacity ?? dw.capacity };
		const sum = (W.price + W.latency + W.reliability + W.capacity) || 1;
		const rows = scored.map((c, i) => {
			let score, reason;
			if (!c.enabled) { score = 0; reason = 'mapping disabled — not routable'; }
			else if (strategy === 'lowest_cost') { score = costS[i]; reason = 'ranked by estimated cost for the token estimate'; }
			else if (strategy === 'lowest_latency') { score = latS[i]; reason = `ranked by observed p95 latency (${c.p95LatencyMs} ms)`; }
			else if (strategy === 'highest_reliability') { score = avS[i]; reason = `ranked by observed availability (${(c.availability * 100).toFixed(1)}%)`; }
			else if (strategy === 'provider_priority') { score = priS[i]; reason = `ranked by provider priority (${c.providerPriority})`; }
			else if (strategy === 'round_robin') { score = 1 - i / Math.max(1, scored.length); reason = `rotation slot ${i + 1} of ${scored.length} (simulated order is deterministic)`; }
			else if (strategy === 'random') { score = 1 - i / Math.max(1, scored.length); reason = `shuffle slot ${i + 1} of ${scored.length} (simulated order is deterministic)`; }
			else { score = (W.price * costS[i] + W.latency * latS[i] + W.reliability * avS[i] + W.capacity * priS[i]) / sum; reason = `weighted mix (price ${W.price}, latency ${W.latency}, reliability ${W.reliability}, capacity ${W.capacity})`; }
			return { providerName: c.providerName, connectionName: c.connectionName, estimatedCostMicro: c.estimatedCostMicro.toString(), healthStatus: c.healthStatus, score: Math.round(score * 1000) / 1000, reason };
		});
		rows.sort((a, b) => (b.score !== a.score ? b.score - a.score : (BigInt(a.estimatedCostMicro) !== BigInt(b.estimatedCostMicro) ? (BigInt(a.estimatedCostMicro) < BigInt(b.estimatedCostMicro) ? -1 : 1) : 0)));
		return { simulated: true, strategy, candidatesConsidered: scored.length, region, projectId, rows };
	}));

	// ---- parity block: security ----
	// Security rules POSTs (admin/security): create/update/delete.
	app.post('/api/admin/security/create', poster('security', async (database, body, userRow) => {
		const name = String(body.name ?? '').trim();
		const kind = _parseEnum(SIGNAL_KINDS, body.kind);
		const action = _parseEnum(SIGNAL_ACTIONS, body.action);
		const threshold = _parseInt(body.threshold, 0, 10000000);
		const windowSeconds = _parseInt(body.window_seconds ?? body.windowSeconds, 1, 2592000);
		const enabled = _parseBool(body.enabled);
		if (!name || name.length > 200) _fail(400, 'Name is required (max 200 chars)');
		if (!kind) _fail(400, 'Unknown signal kind');
		if (!action) _fail(400, 'Action must be log or block');
		if (threshold === null || windowSeconds === null) _fail(400, 'Threshold and window_seconds must be whole numbers in range');
		const config = { threshold, window_seconds: windowSeconds };
		const id = _newId(_IDP.securityRule);
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into security_rule (id, name, kind, config, enabled, action) values (${id}, ${name}, ${kind}, ${JSON.stringify(config)}::jsonb, ${enabled}, ${action})`);
				await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.create', resource: 'security_rule', resourceId: id, after: { name, kind, action, enabled, config } });
			});
		} catch (err) { _fail(400, `Could not create rule: ${err.message ?? 'insert failed'}`); }
		return { created: name };
	}));
	app.post('/api/admin/security/update', poster('security', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const name = String(body.name ?? '').trim();
		const kind = _parseEnum(SIGNAL_KINDS, body.kind);
		const action = _parseEnum(SIGNAL_ACTIONS, body.action);
		const threshold = _parseInt(body.threshold, 0, 10000000);
		const windowSeconds = _parseInt(body.window_seconds ?? body.windowSeconds, 1, 2592000);
		const enabled = _parseBool(body.enabled);
		if (!id) _fail(400, 'Missing rule id');
		if (!name || name.length > 200) _fail(400, 'Name is required (max 200 chars)');
		if (!kind) _fail(400, 'Unknown signal kind');
		if (!action) _fail(400, 'Action must be log or block');
		if (threshold === null || windowSeconds === null) _fail(400, 'Threshold and window_seconds must be whole numbers in range');
		const config = { threshold, window_seconds: windowSeconds };
		const before = _rowsOf(await database.execute(sql`select * from security_rule where id = ${id} and kind <> 'blocked_ip' and kind <> 'blocked_key' limit 1`))[0];
		if (!before) _fail(404, 'Rule not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update security_rule set name = ${name}, kind = ${kind}, action = ${action}, enabled = ${enabled}, config = ${JSON.stringify(config)}::jsonb, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.update', resource: 'security_rule', resourceId: id, before: { name: before.name, kind: before.kind, action: before.action, enabled: before.enabled, config: before.config }, after: { name, kind, action, enabled, config } });
		});
		return { updated: id };
	}));
	app.post('/api/admin/security/delete', poster('security', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing rule id');
		const before = _rowsOf(await database.execute(sql`select * from security_rule where id = ${id} and kind <> 'blocked_ip' and kind <> 'blocked_key' limit 1`))[0];
		if (!before) _fail(404, 'Rule not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from security_rule where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.delete', resource: 'security_rule', resourceId: id, before: { name: before.name, kind: before.kind } });
		});
		return { deleted: id };
	}));
	// Abuse (admin/security/abuse): read-only GET with window stats + signals.
	app.get('/api/admin/security/abuse', handler('security', async (database) => {
		const rules = _rowsOf(await database.execute(sql`select id, name, kind, config, enabled, action from security_rule where kind in (${sql.join(SIGNAL_KINDS.map((k) => sql`${k}`), sql`, `)}) order by name`));
		const req = _rowsOf(await database.execute(sql`with base as (select date_trunc('hour', created_at) as window_start, client_ip, cost, (error_code = 'AUTHENTICATION_ERROR') as is_auth_fail, (status <> 'success') as is_err, (http_status in (401, 403)) as is_cred_fail from request_log where created_at >= now() - interval '24 hours'), per_ip as (select window_start, client_ip, count(*)::int as n from base where client_ip is not null group by 1, 2), ip_stats as (select window_start, count(*)::int as distinct_ips, max(n)::int as top_ip_count from per_ip group by 1), agg as (select window_start, count(*)::int as requests, (count(*) filter (where is_auth_fail))::int as auth_failures, (count(*) filter (where is_err))::int as error_count, (count(*) filter (where is_cred_fail))::int as credential_auth_failures, coalesce(sum(cost),0) as spend_micro from base group by 1) select a.window_start, a.requests, a.auth_failures, a.error_count, a.credential_auth_failures, a.spend_micro, coalesce(i.distinct_ips,0) as distinct_ips, coalesce(i.top_ip_count,0) as top_ip_count from agg a left join ip_stats i on i.window_start = a.window_start order by a.window_start desc`));
		const rots = _rowsOf(await database.execute(sql`select date_trunc('hour', created_at) as window_start, count(*)::int as n from audit_log where created_at >= now() - interval '24 hours' and action in (${sql.join(KEY_LIFECYCLE_ACTIONS.map((a) => sql`${a}`), sql`, `)}) group by 1 order by 1 desc`));
		let budgetMicro = null;
		try { const b = _rowsOf(await database.execute(sql`select count(*)::int as n, coalesce(sum(amount_micro),0) as total from budget`))[0]; if (b && _num(b.n) > 0) budgetMicro = BigInt(String(b.total)); } catch {}
		const byStart = new Map();
		const ensure = (ws) => { const k = new Date(ws).getTime(); if (!byStart.has(k)) byStart.set(k, { windowStart: new Date(ws), requests: 0, authFailures: 0, errorCount: 0, distinctIps: 0, topIpShare: 0, keyRotations: 0, credentialAuthFailures: 0, spendMicro: 0n, budgetMicro }); return byStart.get(k); };
		for (const r of req) { const w = ensure(r.window_start); w.requests = _num(r.requests); w.authFailures = _num(r.auth_failures); w.errorCount = _num(r.error_count); w.credentialAuthFailures = _num(r.credential_auth_failures); w.distinctIps = _num(r.distinct_ips); w.topIpShare = w.requests > 0 ? _num(r.top_ip_count) / w.requests : 0; try { w.spendMicro = BigInt(String(r.spend_micro ?? 0)); } catch { w.spendMicro = 0n; } }
		for (const r of rots) ensure(r.window_start).keyRotations = _num(r.n);
		const windows = [...byStart.values()].sort((a, b) => new Date(b.windowStart) - new Date(a.windowStart));
		const matchedActions = _rowsOf(await database.execute(sql`select distinct action from audit_log where created_at >= now() - interval '24 hours' and action in (${sql.join(KEY_LIFECYCLE_ACTIONS.map((a) => sql`${a}`), sql`, `)}) order by action`)).map((r) => r.action);
		const signals = _evalSignals(rules, windows);
		return { signals: signals.map((s) => ({ ...s, value: String(s.value), spendMicro: undefined })), windows: windows.map((w) => ({ ...w, spendMicro: w.spendMicro.toString(), budgetMicro: w.budgetMicro === null ? null : w.budgetMicro.toString() })), ruleCount: rules.length, enabledRuleCount: rules.filter((r) => r.enabled).length, matchedActions, watchedActions: KEY_LIFECYCLE_ACTIONS, windowHours: 24 };
	}));
	// Audit log (admin/security/audit-log): read-only GET with redaction.
	app.get('/api/admin/security/audit-log', handler('security', async (database, url) => {
		const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
		const action = (url.searchParams.get('action') ?? '').trim();
		const rows = action
			? _rowsOf(await database.execute(sql`select a.id, a.actor_user_id, a.actor_kind, u.email as actor_email, a.action, a.resource, a.resource_id, a.workspace_id, a.ip, a.before, a.after, a.metadata, a.created_at from audit_log a left join "user" u on u.id = a.actor_user_id where a.action = ${action} order by a.created_at desc limit 100 offset ${(page - 1) * 100}`))
			: _rowsOf(await database.execute(sql`select a.id, a.actor_user_id, a.actor_kind, u.email as actor_email, a.action, a.resource, a.resource_id, a.workspace_id, a.ip, a.before, a.after, a.metadata, a.created_at from audit_log a left join "user" u on u.id = a.actor_user_id order by a.created_at desc limit 100 offset ${(page - 1) * 100}`));
		const actions = _rowsOf(await database.execute(sql`select action, count(*)::int as n from audit_log group by action order by count(*) desc limit 30`));
		return { rows: rows.map((r) => _auditView({ id: r.id, actorUserId: r.actor_user_id, actorKind: r.actor_kind, actorEmail: r.actor_email, action: r.action, resource: r.resource, resourceId: r.resource_id, workspaceId: r.workspace_id, ip: r.ip, before: r.before, after: r.after, metadata: r.metadata, createdAt: r.created_at })), actions, page, action: action ?? '' };
	}));
	// Blocked IPs (admin/security/blocked-ips): GET + add/remove.
	app.get('/api/admin/security/blocked-ips', handler('security', async (database) => {
		const rows = _rowsOf(await database.execute(sql`select id, name, config, created_at from security_rule where kind = 'blocked_ip' order by name`));
		return { rules: rows.map((r) => ({ id: r.id, name: r.name, cidr: String(r.config?.cidr ?? ''), createdAt: r.created_at })) };
	}));
	app.post('/api/admin/security/blocked-ips/add', poster('security', async (database, body, userRow) => {
		const cidr = _cleanField(body.cidr, 64);
		const name = _cleanField(body.name, 200) ?? cidr;
		if (!cidr || !_isIpOrCidr(cidr)) _fail(400, 'Enter a valid IP address or CIDR subnet (e.g. 203.0.113.0/24)');
		if (!name) _fail(400, 'Name is required');
		const id = _newId(_IDP.securityRule);
		const config = { cidr };
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into security_rule (id, name, kind, config, enabled, action) values (${id}, ${name}, 'blocked_ip', ${JSON.stringify(config)}::jsonb, true, 'block')`);
				await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.create', resource: 'security_rule', resourceId: id, after: { name, kind: 'blocked_ip', action: 'block', config }, metadata: { page: 'admin.security.blocked-ips' } });
			});
		} catch (err) { _fail(400, `Could not block address: ${err.message ?? 'insert failed'}`); }
		return { added: cidr };
	}));
	app.post('/api/admin/security/blocked-ips/remove', poster('security', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing rule id');
		const before = _rowsOf(await database.execute(sql`select * from security_rule where id = ${id} limit 1`))[0];
		if (!before || before.kind !== 'blocked_ip') _fail(404, 'Rule not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from security_rule where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.delete', resource: 'security_rule', resourceId: id, before: { name: before.name, kind: before.kind, action: before.action, config: before.config }, metadata: { page: 'admin.security.blocked-ips' } });
		});
		return { removed: id };
	}));
	// Blocked keys (admin/security/blocked-keys): GET + add/remove.
	app.get('/api/admin/security/blocked-keys', handler('security', async (database) => {
		const rows = _rowsOf(await database.execute(sql`select id, name, config, created_at from security_rule where kind = 'blocked_key' order by name`));
		const keyIds = rows.map((r) => String(r.config?.key_id ?? '')).filter((s) => s.length > 0);
		let blockedById = {};
		if (keyIds.length) {
			const b = _rowsOf(await database.execute(sql`select id, name, prefix, status from api_key where id in (${sql.join(keyIds.map((k) => sql`${k}`), sql`, `)}) limit 500`));
			blockedById = Object.fromEntries(b.map((k) => [k.id, k]));
		}
		const keys = keyIds.length
			? _rowsOf(await database.execute(sql`select id, name, prefix, status from api_key where id not in (${sql.join(keyIds.map((k) => sql`${k}`), sql`, `)}) order by name limit 500`))
			: _rowsOf(await database.execute(sql`select id, name, prefix, status from api_key order by name limit 500`));
		return { rules: rows.map((r) => { const keyId = String(r.config?.key_id ?? ''); const hit = blockedById[keyId]; return { id: r.id, name: r.name, keyId, keyName: hit?.name ?? null, keyPrefix: hit?.prefix ?? null, keyStatus: hit?.status ?? null, createdAt: r.created_at }; }), keys };
	}));
	app.post('/api/admin/security/blocked-keys/add', poster('security', async (database, body, userRow) => {
		const keyId = String(body.key_id ?? body.keyId ?? '').trim();
		if (!keyId) _fail(400, 'Pick a key to block');
		const key = _rowsOf(await database.execute(sql`select id, name, prefix from api_key where id = ${keyId} limit 1`))[0];
		if (!key) _fail(400, 'Unknown key');
		const name = _cleanField(body.name, 200) ?? `blocked key ${key.prefix}`;
		const id = _newId(_IDP.securityRule);
		const config = { key_id: keyId };
		await database.transaction(async (tx) => {
			await tx.execute(sql`insert into security_rule (id, name, kind, config, enabled, action) values (${id}, ${name}, 'blocked_key', ${JSON.stringify(config)}::jsonb, true, 'block')`);
			await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.create', resource: 'security_rule', resourceId: id, after: { name, kind: 'blocked_key', config }, metadata: { page: 'admin.security.blocked-keys', keyName: key.name, keyPrefix: key.prefix } });
		});
		return { added: keyId };
	}));
	app.post('/api/admin/security/blocked-keys/remove', poster('security', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing rule id');
		const before = _rowsOf(await database.execute(sql`select * from security_rule where id = ${id} limit 1`))[0];
		if (!before || before.kind !== 'blocked_key') _fail(404, 'Rule not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from security_rule where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'security_rule.delete', resource: 'security_rule', resourceId: id, before: { name: before.name, kind: before.kind, config: before.config }, metadata: { page: 'admin.security.blocked-keys' } });
		});
		return { removed: id };
	}));

	// ---- parity block: settings ----
	// Settings POSTs (admin/settings): updateGeneral/updateRegistration/updateRetention/updateDefaultRouting/updateHardLimits/setBillingDefaults.
	app.post('/api/admin/settings/updateGeneral', poster('settings', async (database, body, userRow) => {
		const maintenance = { enabled: _parseBool(body.maintenance) };
		const passthrough = { enabled: _parseBool(body.generic_passthrough ?? body.genericPassthrough) };
		const beforeMaintenance = await _getSetting(database, 'maintenance');
		const beforePassthrough = await _getSetting(database, 'generic_passthrough');
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'maintenance', maintenance, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'maintenance', before: beforeMaintenance, after: maintenance });
			await _setSetting(tx, 'generic_passthrough', passthrough, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'generic_passthrough', before: beforePassthrough, after: passthrough });
		});
		return { saved: 'General settings' };
	}));
	app.post('/api/admin/settings/updateRegistration', poster('settings', async (database, body, userRow) => {
		const after = { enabled: _parseBool(body.registration) };
		const before = await _getSetting(database, 'registration');
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'registration', after, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'registration', before, after });
		});
		return { saved: 'Registration settings' };
	}));
	app.post('/api/admin/settings/updateRetention', poster('settings', async (database, body, userRow) => {
		const days = (n) => _parseInt(body[n], 0, 36500);
		const metadata = days('request_metadata_days'); const content = days('request_content_days');
		const events = days('system_events_days'); const auditLogs = days('audit_logs_days');
		if (metadata === null || content === null || events === null || auditLogs === null) _fail(400, 'Retention values must be whole numbers of days, 0 or more');
		const after = { request_metadata_days: metadata, request_content_days: content, system_events_days: events, audit_logs_days: auditLogs };
		const before = await _getSetting(database, 'retention');
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'retention', after, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'retention', before, after });
		});
		return { saved: 'Retention settings' };
	}));
	app.post('/api/admin/settings/updateDefaultRouting', poster('settings', async (database, body, userRow) => {
		const id = String(body.policyId ?? '').trim();
		if (!id) _fail(400, 'Pick a routing policy');
		const exists = _rowsOf(await database.execute(sql`select id from routing_policy where id = ${id} limit 1`));
		if (!exists.length) _fail(400, 'Unknown routing policy');
		const after = { id };
		const before = await _getSetting(database, 'default_routing_policy');
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'default_routing_policy', after, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'default_routing_policy', before, after });
		});
		return { saved: 'Default routing policy' };
	}));
	app.post('/api/admin/settings/updateHardLimits', poster('settings', async (database, body, userRow) => {
		const rpm = _parseInt(body.rpm, 0, 10000000);
		const tpm = _parseInt(body.tpm, 0, 1000000000000);
		const concurrency = _parseInt(body.concurrency, 0, 100000);
		if (rpm === null || tpm === null || concurrency === null) _fail(400, 'Hard limits must be whole numbers, 0 or more');
		const after = { rpm, tpm, concurrency };
		const before = await _getSetting(database, 'platform_hard_limits');
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'platform_hard_limits', after, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'platform_hard_limits', before, after });
		});
		return { saved: 'Platform hard limits' };
	}));
	app.post('/api/admin/settings/setBillingDefaults', poster('settings', async (database, body, userRow) => {
		const warn = _usdToMicro(String(body.warningUsd ?? ''));
		const hard = _usdToMicro(String(body.hardStopUsd ?? ''));
		if (warn === null || hard === null) _fail(400, 'Enter both thresholds as USD amounts (e.g. 10.00)');
		await database.transaction(async (tx) => {
			const before = _rowsOf(await tx.execute(sql`select warning_threshold_micro, hard_stop_threshold_micro from billing_account`));
			await tx.execute(sql`update billing_account set warning_threshold_micro = ${warn}, hard_stop_threshold_micro = ${hard}, updated_at = now()`);
			let bw = 0n, bh = 0n;
			for (const r of before) { try { bw += BigInt(String(r.warning_threshold_micro)); bh += BigInt(String(r.hard_stop_threshold_micro)); } catch {} }
			await _audit(tx, { actorUserId: userRow.id, action: 'billing_account.defaults_update', resource: 'billing_account', resourceId: 'all', before: { count: before.length, warningTotal: bw.toString(), hardStopTotal: bh.toString() }, after: { warningThresholdMicro: warn, hardStopThresholdMicro: hard } });
		});
		return { saved: 'Billing defaults' };
	}));
	// Feature flags (admin/settings/feature-flags): GET + create/update/toggle/delete.
	app.get('/api/admin/settings/feature-flags', handler('settings', async (database) => {
		const flags = _rowsOf(await database.execute(sql`select id, name, description, enabled, rollout, updated_at from feature_flag order by name`));
		return { flags: flags.map((f) => ({ id: f.id, name: f.name, description: f.description, enabled: f.enabled, rollout: f.rollout, updatedAt: f.updated_at })) };
	}));
	app.post('/api/admin/settings/feature-flags/create', poster('settings', async (database, body, userRow) => {
		const name = _cleanField(body.name, 100);
		const description = _cleanField(body.description, 500) ?? '';
		const enabled = _parseBool(body.enabled);
		const rollout = _parseJson(body.rollout);
		if (!name) _fail(400, 'Name is required (max 100 chars)');
		if (rollout === null) _fail(400, 'Rollout must be a JSON object');
		const dup = _rowsOf(await database.execute(sql`select id from feature_flag where name = ${name} limit 1`));
		if (dup.length) _fail(400, 'A feature flag with that name already exists');
		const id = _newId(_IDP.featureFlag);
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into feature_flag (id, name, description, enabled, rollout, updated_by, updated_at) values (${id}, ${name}, ${description}, ${enabled}, ${JSON.stringify(rollout)}::jsonb, ${userRow.id}, now())`);
				await _audit(tx, { actorUserId: userRow.id, action: 'feature_flag.create', resource: 'feature_flag', resourceId: id, after: { name, enabled } });
			});
		} catch { _fail(400, 'Could not create feature flag'); }
		return { created: name };
	}));
	app.post('/api/admin/settings/feature-flags/update', poster('settings', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const name = _cleanField(body.name, 100);
		const description = _cleanField(body.description, 500) ?? '';
		const enabled = _parseBool(body.enabled);
		const rollout = _parseJson(body.rollout);
		if (!id) _fail(400, 'Missing feature flag id');
		if (!name) _fail(400, 'Name is required (max 100 chars)');
		if (rollout === null) _fail(400, 'Rollout must be a JSON object');
		const dup = _rowsOf(await database.execute(sql`select id from feature_flag where name = ${name} limit 1`))[0];
		if (dup && dup.id !== id) _fail(400, 'A feature flag with that name already exists');
		const before = _rowsOf(await database.execute(sql`select * from feature_flag where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Feature flag not found');
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`update feature_flag set name = ${name}, description = ${description}, enabled = ${enabled}, rollout = ${JSON.stringify(rollout)}::jsonb, updated_by = ${userRow.id}, updated_at = now() where id = ${id}`);
				await _audit(tx, { actorUserId: userRow.id, action: 'feature_flag.update', resource: 'feature_flag', resourceId: id, before: { name: before.name, enabled: before.enabled }, after: { name, enabled } });
			});
		} catch { _fail(400, 'Could not update feature flag'); }
		return { updated: name };
	}));
	app.post('/api/admin/settings/feature-flags/toggle', poster('settings', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing feature flag id');
		const before = _rowsOf(await database.execute(sql`select id, name, enabled from feature_flag where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Feature flag not found');
		const enabled = !before.enabled;
		await database.transaction(async (tx) => {
			await tx.execute(sql`update feature_flag set enabled = ${enabled}, updated_by = ${userRow.id}, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: enabled ? 'feature_flag.enable' : 'feature_flag.disable', resource: 'feature_flag', resourceId: id, before: { enabled: before.enabled }, after: { enabled } });
		});
		return { toggled: id };
	}));
	app.post('/api/admin/settings/feature-flags/delete', poster('settings', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing feature flag id');
		const before = _rowsOf(await database.execute(sql`select id, name from feature_flag where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Feature flag not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from feature_flag where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'feature_flag.delete', resource: 'feature_flag', resourceId: id, before });
		});
		return { deleted: id };
	}));

	// ---- parity block: system ----
	// Database drill-down (admin/system/database): read-only GET.
	app.get('/api/admin/system/database', handler('system', async (database) => {
		let activity = [];
		try { activity = _rowsOf(await database.execute(sql`select pid, state, extract(epoch from (now() - query_start))::float8 as duration, left(query, 120) as query from pg_stat_activity where backend_type = 'client backend' order by state nulls last, duration desc nulls last`)); } catch { activity = []; }
		const active = activity.filter((r) => r.state === 'active');
		const slow = active.filter((r) => Number(r.duration ?? 0) > 1);
		let size = null;
		try { size = _rowsOf(await database.execute(sql`select pg_size_pretty(pg_database_size(current_database())) as database_size, (select count(*)::int from request_log) as request_log_rows, pg_size_pretty(pg_total_relation_size('request_log')) as request_log_size`))[0] ?? null; } catch { size = null; }
		let bloat = [];
		try { bloat = _rowsOf(await database.execute(sql`select relname, n_dead_tup::int as dead_rows, last_autovacuum from pg_stat_user_tables where relname in ('request_log', 'audit_log', 'job') order by n_dead_tup desc`)); } catch { bloat = []; }
		let migration = null;
		try { const r = _rowsOf(await database.execute(sql`select name, applied_at from schema_migration order by applied_at desc nulls last limit 1`))[0]; if (r) migration = { name: String(r.name), appliedAt: r.applied_at ?? null }; } catch { migration = null; }
		return { connections: activity.map((r) => ({ pid: Number(r.pid), state: r.state === null ? 'idle' : String(r.state), durationSeconds: Number(r.duration ?? 0), query: String(r.query ?? '') })), activeCount: active.length, slowQueries: slow.map((r) => ({ pid: Number(r.pid), durationSeconds: Number(r.duration ?? 0), query: String(r.query ?? '') })), databaseSize: size ? String(size.database_size) : null, requestLogRows: size ? Number(size.request_log_rows) : null, requestLogSize: size ? String(size.request_log_size) : null, bloat: bloat.map((r) => ({ table: String(r.relname), deadRows: Number(r.dead_rows ?? 0), lastAutovacuum: r.last_autovacuum ? String(r.last_autovacuum) : null })), migration };
	}));
	// Events (admin/system/events): read-only GET with type filter.
	app.get('/api/admin/system/events', handler('system', async (database, url) => {
		const type = (url.searchParams.get('type') ?? '').trim().slice(0, 120);
		const rows = type
			? _rowsOf(await database.execute(sql`select id, type, resource, resource_id, workspace_id, metadata, created_at from system_event where type = ${type} order by created_at desc limit 200`))
			: _rowsOf(await database.execute(sql`select id, type, resource, resource_id, workspace_id, metadata, created_at from system_event order by created_at desc limit 200`));
		let types = [];
		try { types = _rowsOf(await database.execute(sql`select distinct type from system_event order by type`)).map((r) => r.type); } catch { types = []; }
		return { rows: rows.map((r) => ({ id: r.id, type: r.type, resource: r.resource, resourceId: r.resource_id, workspaceId: r.workspace_id, metadata: r.metadata, createdAt: r.created_at })), types, type };
	}));
	// Health detail (admin/system/health): derived per-provider/component health.
	app.get('/api/admin/system/health', handler('system', async (database) => {
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const providers = _rowsOf(await database.execute(sql`select id, name, slug, status from provider order by name`));
		const connections = _rowsOf(await database.execute(sql`select id, provider_id, name, slug, health_status, enabled from connection order by name`));
		const pTraffic = new Map(_rowsOf(await database.execute(sql`select provider_id, count(*)::int as requests, count(*) filter (where status = 'success')::int as successes from request_log where created_at >= ${since.toISOString()} group by provider_id`)).map((r) => [String(r.provider_id), { requests: _num(r.requests), successes: _num(r.successes) }]));
		const cTraffic = new Map(_rowsOf(await database.execute(sql`select connection_id, count(*)::int as requests, count(*) filter (where status = 'success')::int as successes from request_log where created_at >= ${since.toISOString()} and connection_id is not null group by connection_id`)).map((r) => [String(r.connection_id), { requests: _num(r.requests), successes: _num(r.successes) }]));
		const openIncidents = _rowsOf(await database.execute(sql`select id, title, component, severity, status, started_at from incident where status <> 'resolved' order by started_at desc`));
		let snapshotRows = [];
		try { snapshotRows = _rowsOf(await database.execute(sql`select type, resource, resource_id, created_at from system_event where type like 'provider.%' order by created_at desc limit 500`)); } catch { snapshotRows = []; }
		const latestSnapshot = new Map();
		for (const row of snapshotRows) { if (!row.resource_id || latestSnapshot.has(row.resource_id)) continue; latestSnapshot.set(row.resource_id, row.type === 'provider.recovered' ? 'healthy' : 'degraded'); }
		const incidentsFor = (...names) => openIncidents.filter((i) => names.includes(i.component));
		const healthOf = (names, traffic, snapshot) => {
			const requests = traffic?.requests ?? 0;
			const successRate = traffic && traffic.requests > 0 ? (100 * traffic.successes) / traffic.requests : null;
			return _deriveHealth({ requests, successRate, openIncidents: incidentsFor(...names), latestSnapshot: snapshot });
		};
		const components = providers.map((p) => {
			const pT = pTraffic.get(p.id);
			const names = [p.name, p.slug].filter((n) => n !== null);
			const conns = connections.filter((c) => c.provider_id === p.id).map((c) => {
				const cT = cTraffic.get(c.id);
				const cNames = [c.name, c.slug].filter((n) => n !== null);
				return { id: c.id, name: c.name, slug: c.slug, enabled: c.enabled, healthStatus: c.health_status, health: healthOf(cNames, cT, latestSnapshot.get(c.id) ?? null), requests: cT?.requests ?? 0, successRate: cT && cT.requests > 0 ? (100 * cT.successes) / cT.requests : null, incidents: incidentsFor(...cNames), snapshot: latestSnapshot.get(c.id) ?? null };
			});
			return { id: p.id, name: p.name, slug: p.slug, health: healthOf(names, pT, latestSnapshot.get(p.id) ?? null), requests: pT?.requests ?? 0, successRate: pT && pT.requests > 0 ? (100 * pT.successes) / pT.requests : null, incidents: incidentsFor(...names), snapshot: latestSnapshot.get(p.id) ?? null, connections: conns };
		});
		return { components };
	}));
	// Jobs (admin/system/jobs): GET + retry/cancel.
	app.get('/api/admin/system/jobs', handler('system', async (database, url) => {
		const status = _parseEnum(JOB_STATUSES, url.searchParams.get('status'));
		const rawType = _cleanField(url.searchParams.get('type'), 120);
		const rows = (status && rawType)
			? _rowsOf(await database.execute(sql`select id, type, status, attempts, max_attempts, available_at, started_at, finished_at, error, payload, created_at from job where status = ${status} and type = ${rawType} order by created_at desc limit 100`))
			: status
				? _rowsOf(await database.execute(sql`select id, type, status, attempts, max_attempts, available_at, started_at, finished_at, error, payload, created_at from job where status = ${status} order by created_at desc limit 100`))
				: rawType
					? _rowsOf(await database.execute(sql`select id, type, status, attempts, max_attempts, available_at, started_at, finished_at, error, payload, created_at from job where type = ${rawType} order by created_at desc limit 100`))
					: _rowsOf(await database.execute(sql`select id, type, status, attempts, max_attempts, available_at, started_at, finished_at, error, payload, created_at from job order by created_at desc limit 100`));
		let types = [];
		try { types = _rowsOf(await database.execute(sql`select type from job group by type order by type`)).map((t) => t.type); } catch { types = []; }
		return { rows: rows.map((r) => ({ id: r.id, type: r.type, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, availableAt: r.available_at, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error, payload: r.payload, createdAt: r.created_at })), types, statuses: JOB_STATUSES, status: status ?? '', type: rawType ?? '', retryable: RETRYABLE_JOBS, cancellable: CANCELLABLE_JOBS };
	}));
	app.post('/api/admin/system/jobs/retry', poster('system', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing job id');
		const outcome = await database.transaction(async (tx) => {
			const row = _rowsOf(await tx.execute(sql`select id, type, status, attempts, error from job where id = ${id} limit 1`))[0];
			if (!row) return { kind: 'missing' };
			if (!RETRYABLE_JOBS.includes(row.status)) return { kind: 'conflict' };
			await tx.execute(sql`update job set status = 'pending', attempts = 0, available_at = now(), error = null, started_at = null, finished_at = null where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'job.retry', resource: 'job', resourceId: row.id, before: { status: row.status, attempts: row.attempts, error: row.error }, after: { status: 'pending', attempts: 0, error: null } });
			return { kind: 'ok', id: row.id };
		});
		if (outcome.kind === 'missing') _fail(404, 'Job not found');
		if (outcome.kind === 'conflict') _fail(409, 'Job not in a retryable state (failed/cancelled)');
		return { retried: outcome.id };
	}));
	app.post('/api/admin/system/jobs/cancel', poster('system', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing job id');
		const outcome = await database.transaction(async (tx) => {
			const row = _rowsOf(await tx.execute(sql`select id, status, attempts from job where id = ${id} limit 1`))[0];
			if (!row) return { kind: 'missing' };
			if (!CANCELLABLE_JOBS.includes(row.status)) return { kind: 'conflict' };
			await tx.execute(sql`update job set status = 'cancelled', finished_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'job.cancel', resource: 'job', resourceId: row.id, before: { status: row.status, attempts: row.attempts }, after: { status: 'cancelled' } });
			return { kind: 'ok', id: row.id };
		});
		if (outcome.kind === 'missing') _fail(404, 'Job not found');
		if (outcome.kind === 'conflict') _fail(409, 'Job not cancellable (pending/running only)');
		return { cancelled: outcome.id };
	}));
	// Metrics (admin/system/metrics): read-only GET.
	app.get('/api/admin/system/metrics', handler('system', async (database) => {
		const hourly = _rowsOf(await database.execute(sql`select date_trunc('hour', created_at) as bucket, count(*)::int as requests, count(*) filter (where status = 'success')::int as successes from request_log where created_at >= now() - interval '24 hours' group by 1 order by 1`));
		const errorMix = _rowsOf(await database.execute(sql`select status, coalesce(error_code, '') as error_code, count(*)::int as requests from request_log where created_at >= now() - interval '24 hours' and status <> 'success' group by 1, 2 order by 3 desc`));
		const lat = _rowsOf(await database.execute(sql`select (percentile_cont(0.5) within group (order by latency_ms))::float8 as p50, (percentile_cont(0.95) within group (order by latency_ms))::float8 as p95, (percentile_cont(0.99) within group (order by latency_ms))::float8 as p99, (percentile_cont(0.5) within group (order by ttft_ms))::float8 as ttft_p50, (percentile_cont(0.95) within group (order by ttft_ms))::float8 as ttft_p95 from request_log where created_at >= now() - interval '24 hours'`))[0] ?? {};
		const fb = _rowsOf(await database.execute(sql`select count(*)::int as requests, count(*) filter (where fallback_used)::int as fallbacks from request_log where created_at >= now() - interval '24 hours'`))[0] ?? {};
		const providers = _rowsOf(await database.execute(sql`select id, name from provider order by name`));
		const providerNames = new Map(providers.map((p) => [p.id, p.name]));
		const perProvider = _rowsOf(await database.execute(sql`select provider_id, count(*)::int as requests, count(*) filter (where status = 'success')::int as successes, (percentile_cont(0.5) within group (order by latency_ms))::float8 as p50, (percentile_cont(0.95) within group (order by latency_ms))::float8 as p95 from request_log where created_at >= now() - interval '24 hours' group by provider_id order by 2 desc`));
		const pct = (r, k) => { const v = Number(r?.[k]); return Number.isFinite(v) ? v : null; };
		const requests = _num(fb.requests); const fallbacks = _num(fb.fallbacks);
		return { hourly: hourly.map((r) => ({ bucket: String(r.bucket), requests: _num(r.requests), successes: _num(r.successes) })), errorMix: errorMix.map((r) => ({ status: String(r.status), errorCode: String(r.error_code), requests: _num(r.requests) })), latency: { p50: pct(lat, 'p50'), p95: pct(lat, 'p95'), p99: pct(lat, 'p99'), ttftP50: pct(lat, 'ttft_p50'), ttftP95: pct(lat, 'ttft_p95') }, fallback: { requests, fallbacks, rate: requests > 0 ? (100 * fallbacks) / requests : null }, perProvider: perProvider.map((r) => ({ providerId: String(r.provider_id), providerName: providerNames.get(String(r.provider_id)) ?? String(r.provider_id), requests: _num(r.requests), successes: _num(r.successes), p50: pct(r, 'p50'), p95: pct(r, 'p95') })) };
	}));
	// Valkey (admin/system/valkey): live INFO/DBSIZE/PING + namespace SCAN.
	app.get('/api/admin/system/valkey', handler('system', async () => {
		if (!process.env.VALKEY_URL) return { configured: false, latencyMs: null, dbsize: null, info: { usedMemory: null, maxMemory: null, connectedClients: null, opsPerSec: null, hitRate: null, evictedKeys: null }, namespaces: [], sampled: 0 };
		try {
			const send = (cmd) => _vkSend(cmd, 4000);
			const t0 = Date.now();
			await send('*1\r\n$4\r\nPING\r\n');
			const latencyMs = Date.now() - t0;
			const bulk = (s) => { const i = s.indexOf('\r\n'); const n = parseInt(s.slice(1, i), 10); if (Number.isNaN(n) || n < 0) return null; return s.slice(i + 2, i + 2 + n); };
			const infoRaw = bulk(await send('*1\r\n$4\r\nINFO\r\n')) ?? '';
			const parsed = {};
			for (const line of infoRaw.split('\n')) { const m = /^([^:#\s]+):([^\r]*)/.exec(line.trim()); if (m) parsed[m[1]] = m[2]; }
			const numOrNull = (k) => { const v = parsed[k]; if (v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
			let dbsize = null;
			try { const d = await send('*1\r\n$6\r\nDBSIZE\r\n'); const m = /^:(\d+)/.exec(d); if (m) dbsize = Number(m[1]); } catch {}
			let namespaces = [], sampled = 0;
			try {
				let cursor = '0'; const counts = {}; let seen = 0;
				do {
					const cmd = `*6\r\n$4\r\nSCAN\r\n$${cursor.length}\r\n${cursor}\r\n$5\r\nMATCH\r\n$1\r\n*\r\n$5\r\nCOUNT\r\n$3\r\n500\r\n`;
					const raw = await send(cmd);
					const lines = raw.split('\r\n');
					cursor = lines[2] ?? '0';
					for (let i = 4; i < lines.length; i++) { const k = lines[i]; if (!k || k.startsWith(':') || k.startsWith('*') || k.startsWith('$')) continue; const ns = k.split(':')[0]; counts[ns] = (counts[ns] ?? 0) + 1; if (++seen >= 5000) break; }
					if (seen >= 5000) break;
				} while (cursor !== '0');
				namespaces = VK_NAMESPACES.map((prefix) => ({ prefix, count: counts[prefix] ?? 0 }));
				sampled = seen;
			} catch {}
			const hits = numOrNull('keyspace_hits'), misses = numOrNull('keyspace_misses');
			return { configured: true, latencyMs, dbsize, info: { usedMemory: numOrNull('used_memory'), maxMemory: numOrNull('maxmemory'), connectedClients: numOrNull('connected_clients'), opsPerSec: numOrNull('instantaneous_ops_per_sec'), hitRate: (hits !== null && misses !== null && hits + misses > 0) ? hits / (hits + misses) : null, evictedKeys: numOrNull('evicted_keys') }, namespaces, sampled };
		} catch { return { configured: true, latencyMs: null, dbsize: null, info: { usedMemory: null, maxMemory: null, connectedClients: null, opsPerSec: null, hitRate: null, evictedKeys: null }, namespaces: [], sampled: 0 }; }
	}));
	// Workers (admin/system/workers): read-only GET.
	app.get('/api/admin/system/workers', handler('system', async (database) => {
		let groups = [];
		try { groups = _rowsOf(await database.execute(sql`select status, type, count(*)::int as n from job group by status, type`)); } catch { groups = []; }
		let running = [];
		try { running = _rowsOf(await database.execute(sql`select id, type, attempts, max_attempts, started_at, available_at, created_at from job where status = 'running' order by started_at desc limit 50`)); } catch { running = []; }
		return { groups: groups.map((g) => ({ status: g.status, type: g.type, n: _num(g.n) })), running: running.map((r) => ({ id: r.id, type: r.type, attempts: r.attempts, maxAttempts: r.max_attempts, startedAt: r.started_at, availableAt: r.available_at, createdAt: r.created_at })) };
	}));

	// ---- parity block: traffic ----
	// Traffic save (admin/traffic): POST.
	app.post('/api/admin/traffic/save', poster('traffic', async (database, body, userRow) => {
		const rpm = _parseInt(body.rpm, 0, 1000000000);
		const tpm = _parseInt(body.tpm, 0, 1000000000);
		const concurrency = _parseInt(body.concurrency, 0, 1000000000);
		if (rpm === null || tpm === null || concurrency === null) _fail(400, 'All three limits must be whole numbers (0 = no cap)');
		const before = await _getSetting(database, 'platform_hard_limits');
		const after = { rpm, tpm, concurrency };
		await database.transaction(async (tx) => {
			await _setSetting(tx, 'platform_hard_limits', after, userRow.id);
			await _audit(tx, { actorUserId: userRow.id, action: 'system_setting.update', resource: 'system_setting', resourceId: 'platform_hard_limits', before: before ?? null, after });
		});
		return { saved: true };
	}));
	// Queues (admin/traffic/queues): read-only GET.
	app.get('/api/admin/traffic/queues', handler('traffic', async (database) => {
		let counts = [];
		try { counts = _rowsOf(await database.execute(sql`select status, type, count(*)::int as n from job group by status, type`)); } catch { counts = []; }
		let live = [];
		try { live = _rowsOf(await database.execute(sql`select id, type, status, attempts, max_attempts, available_at, error from job where status in ('pending', 'running') order by available_at limit 100`)); } catch { live = []; }
		let inFlightLastMinute = 0;
		try { inFlightLastMinute = _num(_rowsOf(await database.execute(sql`select count(*)::int as n from request_log where created_at >= now() - interval '60 seconds'`))[0]?.n); } catch {}
		return { counts: counts.map((c) => ({ status: c.status, type: c.type, n: _num(c.n) })), live: live.map((r) => ({ id: r.id, type: r.type, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, availableAt: r.available_at, error: r.error })), inFlightLastMinute };
	}));
	// Rate limits (admin/traffic/rate-limits): GET + create/update/delete.
	app.get('/api/admin/traffic/rate-limits', handler('traffic', async (database) => {
		const rows = _rowsOf(await database.execute(sql`select * from rate_limit order by scope, scope_id`));
		const budgets = _rowsOf(await database.execute(sql`select * from budget order by scope, scope_id, period`));
		return { limits: rows.map((r) => ({ id: r.id, scope: r.scope, scopeId: r.scope_id, rpm: r.rpm, tpm: r.tpm, rpd: r.rpd, tpd: r.tpd, concurrency: r.concurrency, dailySpendUsd: _microToUsd(r.daily_spend_micro), monthlySpendUsd: _microToUsd(r.monthly_spend_micro) })), budgets: budgets.map((b) => ({ id: b.id, scope: b.scope, scopeId: b.scope_id, period: b.period, amountMicro: String(b.amount_micro), warnPercent: b.warn_percent, criticalPercent: b.critical_percent, actionAt100: b.action_at_100 })), scopes: RATE_SCOPES };
	}));
	const _readLimits = (body) => {
		const optInt = (raw) => { const v = String(raw ?? '').trim(); if (!v) return null; const n = _parseInt(v, 0, 1000000000000); return n === null ? 'invalid' : n; };
		const optMoney = (raw) => { const v = String(raw ?? '').trim(); if (!v) return null; const m = _usdToMicro(v); return m === null ? 'invalid' : m; };
		const rpm = optInt(body.rpm); const tpm = optInt(body.tpm); const rpd = optInt(body.rpd);
		const tpd = optInt(body.tpd); const concurrency = optInt(body.concurrency);
		const daily = optMoney(body.dailySpendUsd ?? body.dailySpendMicro); const monthly = optMoney(body.monthlySpendUsd ?? body.monthlySpendMicro);
		if (rpm === 'invalid' || tpm === 'invalid' || rpd === 'invalid' || tpd === 'invalid' || concurrency === 'invalid' || daily === 'invalid' || monthly === 'invalid') return null;
		return { rpm, tpm, rpd, tpd, concurrency, dailySpendMicro: daily, monthlySpendMicro: monthly };
	};
	app.post('/api/admin/traffic/rate-limits/create', poster('traffic', async (database, body, userRow) => {
		const scope = _parseEnum(RATE_SCOPES, body.scope);
		const scopeId = String(body.scopeId ?? '').trim();
		if (!scope || !scopeId || scopeId.length > 200) _fail(400, 'Scope and scope id are required');
		const limits = _readLimits(body);
		if (!limits) _fail(400, 'Limits must be whole numbers; caps in USD');
		const id = _newId(_IDP.rateLimit);
		try {
			await database.transaction(async (tx) => {
				await tx.execute(sql`insert into rate_limit (id, scope, scope_id, rpm, tpm, rpd, tpd, concurrency, daily_spend_micro, monthly_spend_micro) values (${id}, ${scope}, ${scopeId}, ${limits.rpm}, ${limits.tpm}, ${limits.rpd}, ${limits.tpd}, ${limits.concurrency}, ${limits.dailySpendMicro}, ${limits.monthlySpendMicro})`);
				await _audit(tx, { actorUserId: userRow.id, action: 'rate_limit.create', resource: 'rate_limit', resourceId: id, after: { scope, scopeId, ...limits } });
			});
		} catch (err) { _fail(400, `Could not create rate limit: ${err.message ?? 'insert failed'}`); }
		return { created: scopeId };
	}));
	app.post('/api/admin/traffic/rate-limits/update', poster('traffic', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing rate limit id');
		const limits = _readLimits(body);
		if (!limits) _fail(400, 'Limits must be whole numbers; caps in USD');
		const before = _rowsOf(await database.execute(sql`select * from rate_limit where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Rate limit not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update rate_limit set rpm = ${limits.rpm}, tpm = ${limits.tpm}, rpd = ${limits.rpd}, tpd = ${limits.tpd}, concurrency = ${limits.concurrency}, daily_spend_micro = ${limits.dailySpendMicro}, monthly_spend_micro = ${limits.monthlySpendMicro}, updated_at = now() where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'rate_limit.update', resource: 'rate_limit', resourceId: id, before: { scope: before.scope, scopeId: before.scope_id }, after: { scope: before.scope, scopeId: before.scope_id, ...limits } });
		});
		return { updated: id };
	}));
	app.post('/api/admin/traffic/rate-limits/delete', poster('traffic', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing rate limit id');
		const before = _rowsOf(await database.execute(sql`select * from rate_limit where id = ${id} limit 1`))[0];
		if (!before) _fail(404, 'Rate limit not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`delete from rate_limit where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'rate_limit.delete', resource: 'rate_limit', resourceId: id, before: { scope: before.scope, scopeId: before.scope_id } });
		});
		return { deleted: id };
	}));
	// Throttling (admin/traffic/throttling): read-only GET.
	app.get('/api/admin/traffic/throttling', handler('traffic', async (database) => {
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const recent = _rowsOf(await database.execute(sql`select r.id, r.created_at, r.api_key_id, k.name as key_name, r.project_id, p.name as project_name, r.workspace_id, r.status, r.error_code, r.http_status from request_log r left join api_key k on k.id = r.api_key_id left join project p on p.id = r.project_id where (r.status = 'rate_limited' or r.error_code = 'RATE_LIMITED') and r.created_at >= ${since.toISOString()} order by r.created_at desc limit 200`));
		const hourly = _rowsOf(await database.execute(sql`select date_trunc('hour', r.created_at) as hour, r.api_key_id, k.name as key_name, r.project_id, p.name as project_name, count(*)::int as n from request_log r left join api_key k on k.id = r.api_key_id left join project p on p.id = r.project_id where (r.status = 'rate_limited' or r.error_code = 'RATE_LIMITED') and r.created_at >= ${since.toISOString()} group by date_trunc('hour', r.created_at), r.api_key_id, k.name, r.project_id, p.name order by date_trunc('hour', r.created_at) desc, count(*) desc limit 100`));
		let concurrency = [];
		let valkeyUp = false;
		if (process.env.VALKEY_URL) {
			try {
				const send = (cmd) => _vkSend(cmd, 4000);
				const raw = await send('*2\r\n$4\r\nKEYS\r\n$7\r\nconc:*\r\n');
				const keys = raw.split('\r\n').filter((l) => l.startsWith('conc:'));
				// An error reply is not "up": a RESP error means the command was
				// rejected (wrong credentials, NOAUTH), and the panel must not
				// paint a healthy badge over an instance it cannot read.
				valkeyUp = !raw.startsWith('-');
				if (keys.length) {
					const parts = [`*${keys.length * 2 + 1}`, '$4', 'MGET'];
					for (const k of keys) parts.push(`$${Buffer.byteLength(k)}`, k);
					const mraw = await send(parts.join('\r\n') + '\r\n');
					const vals = mraw.split('\r\n').filter((l) => /^-?\d+$/.test(l)).map(Number);
					concurrency = keys.map((key, i) => ({ key, inFlight: vals[i] ?? 0 })).filter((c) => c.inFlight > 0).sort((a, b) => b.inFlight - a.inFlight).slice(0, 50);
				}
			} catch { concurrency = []; }
		}
		return { recent: recent.map((r) => ({ id: r.id, createdAt: r.created_at, apiKeyId: r.api_key_id, keyName: r.key_name, projectId: r.project_id, projectName: r.project_name, workspaceId: r.workspace_id, status: r.status, errorCode: r.error_code, httpStatus: r.http_status })), hourly: hourly.map((r) => ({ hour: r.hour, apiKeyId: r.api_key_id, keyName: r.key_name, projectId: r.project_id, projectName: r.project_name, n: _num(r.n) })), concurrency, valkeyUp };
	}));
	// ---- parity block: users ----
	// User role/ban POSTs (admin/users): setRole/toggleBan.
	app.post('/api/admin/users/setRole', poster('users', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const role = String(body.role ?? '').trim();
		if (!id || !['user', 'finance_admin', 'ops_admin', 'admin'].includes(role)) _fail(400, 'Invalid role');
		if (id === userRow.id) _fail(400, 'You cannot change your own role');
		const target = _rowsOf(await database.execute(sql`select role from "user" where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'User not found');
		const refusal = _guardUser(userRow, target.role, role);
		if (refusal) _fail(403, refusal);
		await database.transaction(async (tx) => {
			await tx.execute(sql`update "user" set role = ${role} where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'user.role_set', resource: 'user', resourceId: id, before: { role: target.role }, after: { role } });
		});
		return { roleSet: id };
	}));
	app.post('/api/admin/users/toggleBan', poster('users', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing user id');
		if (id === userRow.id) _fail(400, 'You cannot ban yourself');
		const target = _rowsOf(await database.execute(sql`select banned, role from "user" where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'User not found');
		const refusal = _guardUser(userRow, target.role);
		if (refusal) _fail(403, refusal);
		const nowBanned = !target.banned;
		await database.transaction(async (tx) => {
			await tx.execute(sql`update "user" set banned = ${nowBanned} where id = ${id}`);
			if (nowBanned) { try { await tx.execute(sql`delete from session where user_id = ${id}`); } catch {} }
			await _audit(tx, { actorUserId: userRow.id, action: nowBanned ? 'user.ban' : 'user.unban', resource: 'user', resourceId: id, before: { banned: target.banned }, after: { banned: nowBanned }, metadata: nowBanned ? { sessionsRevoked: true } : {} });
		});
		return { bannedToggled: id };
	}));
	// User detail (admin/users/[id]): GET + suspend/unsuspend/disableAccess.
	app.get('/api/admin/users/:id', handler('users', async (database, url) => {
		const id = String(url.pathname.split('/').pop());
		const account = _rowsOf(await database.execute(sql`select id, name, email, role, banned, ban_reason, email_verified, created_at, updated_at from "user" where id = ${id} limit 1`))[0];
		if (!account) { const e = new ctx.HttpError(404, 'User not found'); throw e; }
		const memberships = _rowsOf(await database.execute(sql`select wm.id as member_id, w.id as workspace_id, w.name as workspace_name, w.slug as workspace_slug, w.status as workspace_status, wr.name as role, wm.status from workspace_member wm join workspace w on w.id = wm.workspace_id left join workspace_role wr on wr.id = wm.role_id where wm.user_id = ${id} order by w.name`));
		const projects = _rowsOf(await database.execute(sql`select p.id, p.name, p.slug, p.status, w.name as workspace_name from project p join workspace_member wm on wm.workspace_id = p.workspace_id join workspace w on w.id = p.workspace_id where wm.user_id = ${id} order by w.name, p.name`));
		const usage = _rowsOf(await database.execute(sql`select count(*)::int as requests, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost, max(created_at) as last_request from request_log where user_id = ${id}`))[0] ?? {};
		const accounts = _rowsOf(await database.execute(sql`select ba.workspace_id, w.name as workspace_name, ba.id as account_id, ba.currency, ba.status, ba.balance_micro as cached_balance from billing_account ba join workspace_member wm on wm.workspace_id = ba.workspace_id join workspace w on w.id = ba.workspace_id where wm.user_id = ${id} order by w.name`));
		const billing = [];
		for (const a of accounts) {
			let live = String(a.cached_balance ?? '0');
			let balanceStale = false;
			try { live = String(_rowsOf(await database.execute(sql`select coalesce(sum(amount_micro),0)::text as total from credit_ledger where billing_account_id = ${a.account_id}`))[0]?.total ?? live); } catch { balanceStale = true; }
			billing.push({ workspaceId: a.workspace_id, workspaceName: a.workspace_name, accountId: a.account_id, currency: String(a.currency).trim(), status: a.status, cachedBalanceMicro: String(a.cached_balance ?? '0'), balanceMicro: live, balanceStale });
		}
		const keys = _rowsOf(await database.execute(sql`select id, name, prefix, status, last_used_at, revoked_at, created_at from api_key where user_id = ${id} order by created_at`));
		let sessionCount = 0;
		try { sessionCount = _num(_rowsOf(await database.execute(sql`select count(*)::int as n from session where user_id = ${id}`))[0]?.n); } catch {}
		let sessAt = null, keyAt = null;
		try { sessAt = _rowsOf(await database.execute(sql`select max(created_at) as at from session where user_id = ${id}`))[0]?.at ?? null; } catch {}
		try { keyAt = _rowsOf(await database.execute(sql`select max(last_used_at) as at from api_key where user_id = ${id}`))[0]?.at ?? null; } catch {}
		const ds = [usage.last_request, sessAt, keyAt].filter((d) => d instanceof Date);
		return { account: { id: account.id, name: account.name, email: account.email, role: account.role, banned: account.banned, banReason: account.ban_reason, emailVerified: account.email_verified, createdAt: account.created_at, updatedAt: account.updated_at }, memberships: memberships.map((m) => ({ memberId: m.member_id, workspaceId: m.workspace_id, workspaceName: m.workspace_name, workspaceSlug: m.workspace_slug, workspaceStatus: m.workspace_status, role: m.role, status: m.status })), projects, usage: { requests: _num(usage.requests), tokensIn: _num(usage.tokens_in), tokensOut: _num(usage.tokens_out), cost: String(usage.cost ?? '0'), lastRequest: usage.last_request ?? null }, billing, keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, createdAt: k.created_at })), sessionCount, lastActivity: ds.length ? new Date(Math.max(...ds.map((d) => d.getTime()))) : null };
	}));
	app.post('/api/admin/users/suspend', poster('users', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing user id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Confirm to suspend this account');
		if (id === userRow.id) _fail(400, 'You cannot suspend yourself');
		const target = _rowsOf(await database.execute(sql`select banned, role from "user" where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'User not found');
		const refusal = _guardUser(userRow, target.role);
		if (refusal) _fail(403, refusal);
		await database.transaction(async (tx) => {
			await tx.execute(sql`update "user" set banned = true where id = ${id}`);
			try { await tx.execute(sql`delete from session where user_id = ${id}`); } catch {}
			await _audit(tx, { actorUserId: userRow.id, action: 'user.suspend', resource: 'user', resourceId: id, before: { banned: target.banned }, after: { banned: true }, metadata: { sessionsRevoked: true } });
		});
		return { suspended: id };
	}));
	app.post('/api/admin/users/unsuspend', poster('users', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing user id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Confirm to unsuspend this account');
		const target = _rowsOf(await database.execute(sql`select banned, role from "user" where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'User not found');
		const refusal = _guardUser(userRow, target.role);
		if (refusal) _fail(403, refusal);
		await database.transaction(async (tx) => {
			await tx.execute(sql`update "user" set banned = false where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'user.unsuspend', resource: 'user', resourceId: id, before: { banned: target.banned }, after: { banned: false } });
		});
		return { unsuspended: id };
	}));
	app.post('/api/admin/users/disableAccess', poster('users', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing user id');
		if (body.confirm !== 'on' && body.confirm !== true) _fail(400, 'Confirm to disable access for this account');
		if (id === userRow.id) _fail(400, 'You cannot disable your own access');
		const target = _rowsOf(await database.execute(sql`select banned, role from "user" where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'User not found');
		const refusal = _guardUser(userRow, target.role);
		if (refusal) _fail(403, refusal);
		const disabled = await database.transaction(async (tx) => {
			await tx.execute(sql`update "user" set banned = false where id = ${id}`);
			try { await tx.execute(sql`delete from session where user_id = ${id}`); } catch {}
			let n = 0;
			try { const r = _rowsOf(await tx.execute(sql`update api_key set status = 'disabled' where user_id = ${id} returning id`)); n = r.length; } catch {}
			await _audit(tx, { actorUserId: userRow.id, action: 'user.access_disabled', resource: 'user', resourceId: id, before: { banned: target.banned }, after: { banned: false, keyStatus: 'disabled' }, metadata: { sessionsRevoked: true, keysDisabled: n } });
			return n;
		});
		return { accessDisabled: id, keysDisabled: disabled };
	}));
	// ---- parity block: workspaces ----
	// Workspace detail (admin/workspaces/[id]): GET + setStatus/suspend/unsuspend.
	app.get('/api/admin/workspaces/:id', handler('workspaces', async (database, url) => {
		const id = String(url.pathname.split('/').pop());
		const w = _rowsOf(await database.execute(sql`select w.id, w.name, w.slug, w.status, w.settings, w.created_at, w.updated_at, w.owner_user_id, u.email as owner_email from workspace w left join "user" u on u.id = w.owner_user_id where w.id = ${id} limit 1`))[0];
		if (!w) { const e = new ctx.HttpError(404, 'Workspace not found'); throw e; }
		const members = _rowsOf(await database.execute(sql`select wm.id as member_id, wm.user_id, u.email as user_email, u.name as user_name, wr.name as role, wm.status from workspace_member wm join "user" u on u.id = wm.user_id left join workspace_role wr on wr.id = wm.role_id where wm.workspace_id = ${id}`));
		const projects = _rowsOf(await database.execute(sql`select id, name, slug, status, created_at from project where workspace_id = ${id} order by name`));
		const usage = _rowsOf(await database.execute(sql`select count(*)::int as requests, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost),0)::text as cost from request_log where workspace_id = ${id}`))[0] ?? {};
		const acct = _rowsOf(await database.execute(sql`select id, currency, status, balance_micro from billing_account where workspace_id = ${id} limit 1`))[0] ?? null;
		let billing = null;
		if (acct) {
			let live = String(acct.balance_micro ?? '0');
			let balanceStale = false;
			try { live = String(_rowsOf(await database.execute(sql`select coalesce(sum(amount_micro),0)::text as total from credit_ledger where billing_account_id = ${acct.id}`))[0]?.total ?? live); } catch { balanceStale = true; }
			billing = { accountId: acct.id, currency: String(acct.currency).trim(), status: acct.status, cachedBalanceMicro: String(acct.balance_micro ?? '0'), balanceMicro: live, balanceStale };
		}
		return { workspace: { id: w.id, name: w.name, slug: w.slug, status: w.status, settings: w.settings, createdAt: w.created_at, updatedAt: w.updated_at, ownerId: w.owner_user_id, ownerEmail: w.owner_email }, members: members.map((m) => ({ memberId: m.member_id, userId: m.user_id, userEmail: m.user_email, userName: m.user_name, role: m.role, status: m.status })), projects, usage: { requests: _num(usage.requests), tokensIn: _num(usage.tokens_in), tokensOut: _num(usage.tokens_out), cost: String(usage.cost ?? '0') }, billing, statuses: WORKSPACE_STATUSES };
	}));
	app.post('/api/admin/workspaces/setStatus', poster('workspaces', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		const status = String(body.status ?? '').trim();
		if (!id) _fail(400, 'Missing workspace id');
		if (!WORKSPACE_STATUSES.includes(status)) _fail(400, 'Invalid status');
		const target = _rowsOf(await database.execute(sql`select status from workspace where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'Workspace not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update workspace set status = ${status} where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'workspace.status_set', resource: 'workspace', resourceId: id, workspaceId: id, before: { status: target.status }, after: { status } });
		});
		return { statusSet: id };
	}));
	app.post('/api/admin/workspaces/suspend', poster('workspaces', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing workspace id');
		const target = _rowsOf(await database.execute(sql`select status from workspace where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'Workspace not found');
		const suspended = await database.transaction(async (tx) => {
			await tx.execute(sql`update workspace set status = 'suspended' where id = ${id}`);
			const rows = _rowsOf(await tx.execute(sql`update project set status = 'suspended' where workspace_id = ${id} returning id`));
			await _audit(tx, { actorUserId: userRow.id, action: 'workspace.suspend', resource: 'workspace', resourceId: id, workspaceId: id, before: { status: target.status }, after: { status: 'suspended' }, metadata: { projectsSuspended: rows.map((p) => p.id) } });
			return rows;
		});
		return { suspended: id, projectsSuspended: suspended.length };
	}));
	app.post('/api/admin/workspaces/unsuspend', poster('workspaces', async (database, body, userRow) => {
		const id = String(body.id ?? '').trim();
		if (!id) _fail(400, 'Missing workspace id');
		const target = _rowsOf(await database.execute(sql`select status from workspace where id = ${id} limit 1`))[0];
		if (!target) _fail(404, 'Workspace not found');
		await database.transaction(async (tx) => {
			await tx.execute(sql`update workspace set status = 'active' where id = ${id}`);
			await _audit(tx, { actorUserId: userRow.id, action: 'workspace.unsuspend', resource: 'workspace', resourceId: id, workspaceId: id, before: { status: target.status }, after: { status: 'active' } });
		});
		return { unsuspended: id };
	}));

}
