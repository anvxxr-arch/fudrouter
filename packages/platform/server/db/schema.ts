import { sql } from 'drizzle-orm';
import {
	pgTable,
	text,
	timestamp,
	jsonb,
	integer,
	bigint,
	numeric,
	char,
	boolean,
	inet,
	index,
	uniqueIndex,
	unique,
	primaryKey
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema.ts';

// profile — 1:1 with Better Auth user
export const profile = pgTable('profile', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	avatar: text('avatar'),
	timezone: text('timezone'),
	preferences: jsonb('preferences').$type<Record<string, unknown>>().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// api_key — hash-only. `prefix` is indexed for lookup; `keyHash` = sha256(secret) hex.
export const apiKey = pgTable(
	'api_key',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		prefix: text('prefix').notNull(),
		keyHash: text('key_hash').notNull(),
		limits: jsonb('limits').$type<Record<string, unknown>>().notNull().default({}),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// -- added by 0006_platform_schema.sql --
		// 0019 dropped the workspace/project/environment columns: `user_id` above
		// is the owner, and a key has no second scope.
		status: text('status').notNull().default('active'),
		policy: jsonb('policy').$type<Record<string, unknown>>().notNull().default({}),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('api_key_prefix_idx').on(t.prefix),
		index('api_key_user_idx').on(t.userId)
	]
);

// provider — credentialsEnc = base64(iv[12]||ct||tag[16]), AES-256-GCM
// `name` is unique so the seed/onboarding scripts can upsert by name.
export const provider = pgTable(
	'provider',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		baseUrl: text('base_url').notNull(),
		credentialsEnc: text('credentials_enc').notNull(),
		status: text('status').notNull().default('active'),
		priority: integer('priority').notNull().default(100),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// -- added by 0006_platform_schema.sql --
		slug: text('slug'),
		description: text('description'),
		type: text('type'),
		// `tier` carries the S0 dev gate forward: S0 gated on
		// provider.status='dev', a value the PRD §52 status vocabulary does not
		// have. The data plane serves tier='commercial' always and tier='dev'
		// only under ROUTER_ALLOW_DEV_PROVIDERS (spec §4).
		tier: text('tier').notNull().default('commercial'),
		homepage: text('homepage'),
		documentationUrl: text('documentation_url'),
		enabled: boolean('enabled').notNull().default(true),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('provider_name_idx').on(t.name), uniqueIndex('provider_slug_idx').on(t.slug)]
);

// model — prices are MINOR UNITS PER 1M TOKENS, numeric(18,6).
// e.g. USD $0.15 per 1M input tokens -> inputPrice '150000.000000' (micro-USD).
//
// Precision is 18, NOT the 12 the spec drafted: micro-USD needs 6 decimals AND
// 6 integer digits just to reach $1.00 per 1M tokens, so numeric(12,6) caps out
// at $0.999999/1M — real upstreams are $2-$75/1M and Postgres rejects them with
// "must round to an absolute value less than 10^6". 18,6 holds up to $999,999/1M.
export const model = pgTable(
	'model',
	{
		id: text('id').primaryKey(),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		context: integer('context'),
		inputPrice: numeric('input_price', { precision: 18, scale: 6 }).notNull(),
		outputPrice: numeric('output_price', { precision: 18, scale: 6 }).notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// -- added by 0006_platform_schema.sql --
		family: text('family'),
		developer: text('developer'),
		description: text('description'),
		modality: jsonb('modality').$type<Record<string, unknown>>().notNull().default({}),
		maxOutput: integer('max_output'),
		capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('model_slug_idx').on(t.slug)]
);

// request_log — append-only, highest-volume table. cost = micro-units of currency.
//
// The ledger must SURVIVE deletion of its subject. `user_id`/`api_key_id` are
// nullable with ON DELETE SET NULL (not CASCADE): removing a user or a key used
// to erase that subject's entire usage and cost history — the financial record —
// in one statement. A NULL subject is the anonymised form; model/provider/cost
// aggregates stay intact. Never make these CASCADE again.
export const requestLog = pgTable(
	'request_log',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		apiKeyId: text('api_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
		// NULL = the request died before a model/provider resolved (spec §8):
		// auth 401, limit 429/402, budget block, MODEL_NOT_FOUND. 0011 dropped
		// the S0 NOT NULL on both so those rows still reach the ledger.
		modelId: text('model_id').references(() => model.id),
		providerId: text('provider_id').references(() => provider.id),
		// 0006 widens tokens_in/tokens_out to bigint (were integer); names stand.
		tokensIn: bigint('tokens_in', { mode: 'number' })
			.notNull()
			.default(0),
		tokensOut: bigint('tokens_out', { mode: 'number' })
			.notNull()
			.default(0),
		cost: bigint('cost', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		latencyMs: integer('latency_ms').notNull().default(0),
		status: text('status').notNull(),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		// -- added by 0006_platform_schema.sql --
		// 0019 dropped the workspace/project/environment columns. Ownership is
		// the nullable `user_id`/`api_key_id` above, which stay SET NULL so the
		// financial record survives subject deletion.
		endpoint: text('endpoint'),
		requestedModel: text('requested_model'),
		providerModelId: text('provider_model_id'),
		connectionId: text('connection_id'),
		credentialId: text('credential_id'),
		routingPolicyId: text('routing_policy_id'),
		strategy: text('strategy'),
		errorCode: text('error_code'),
		httpStatus: integer('http_status'),
		// NULL = provider did not report; 0 = reported zero (PRD §122).
		cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }),
		reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }),
		totalTokens: bigint('total_tokens', { mode: 'number' }),
		inputPriceMicro: numeric('input_price_micro', { precision: 18, scale: 6 }),
		cachedInputPriceMicro: numeric('cached_input_price_micro', { precision: 18, scale: 6 }),
		outputPriceMicro: numeric('output_price_micro', { precision: 18, scale: 6 }),
		reasoningPriceMicro: numeric('reasoning_price_micro', { precision: 18, scale: 6 }),
		pricingRuleId: text('pricing_rule_id'),
		providerCostMicro: bigint('provider_cost_micro', { mode: 'bigint' }),
		creditChargedMicro: bigint('credit_charged_micro', { mode: 'bigint' }),
		ttftMs: integer('ttft_ms'),
		timing: jsonb('timing').$type<Record<string, number>>(),
		attempts: integer('attempts').notNull().default(1),
		fallbackUsed: boolean('fallback_used').notNull().default(false),
		stream: boolean('stream').notNull().default(false),
		clientDisconnected: boolean('client_disconnected').notNull().default(false),
		// PRD §29 Request Metadata (IP) + §70 abuse signals (IP distribution).
		// inet, not text: PostgreSQL rejects a malformed address at write time and
		// supports subnet matching for the security center. 0008.
		clientIp: inet('client_ip'),
		requestBody: text('request_body'),
		responseBody: text('response_body')
	},
	(t) => [
		index('request_log_user_created_idx').on(t.userId, t.createdAt),
		index('request_log_api_key_created_idx').on(t.apiKeyId, t.createdAt),
		index('request_log_provider_created_idx').on(t.providerId, t.createdAt),
		index('request_log_model_created_idx').on(t.modelId, t.createdAt),
		index('request_log_status_created_idx').on(t.status, t.createdAt),
		index('request_log_client_ip_created_idx').on(t.clientIp, t.createdAt)
	]
);

// ------------------------------------------------------------- accounts ----
// The account IS the tenant (migration 0019). `workspace`, `workspace_member`,
// `workspace_role`, `project` and `environment` are gone; a key, billing account,
// budget, rate limit and routing policy hang off `user.id` directly.

export const routingPolicy = pgTable(
	'routing_policy',
	{
		id: text('id').primaryKey(),
		// NULL = the platform default. Account rows carry the owner's user id.
		accountId: text('account_id').references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		strategy: text('strategy').notNull().default('balanced'),
		enabled: boolean('enabled').notNull().default(true),
		maxAttempts: integer('max_attempts').notNull().default(2),
		requestTimeoutMs: integer('request_timeout_ms').notNull().default(30000),
		fallbackEnabled: boolean('fallback_enabled').notNull().default(true),
		providerPreferences: jsonb('provider_preferences')
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		modelPreferences: jsonb('model_preferences')
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		constraints: jsonb('constraints').$type<Record<string, unknown>>().notNull().default({}),
		weights: jsonb('weights').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('routing_policy_account_idx').on(t.accountId)]
);

// ------------------------------------------------------------- provider net ----
// PRD §52–56: Provider -> Connection -> Credential.

export const connection = pgTable(
	'connection',
	{
		id: text('id').primaryKey(),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		baseUrl: text('base_url').notNull(),
		region: text('region'),
		authType: text('auth_type').notNull().default('bearer'),
		timeoutMs: integer('timeout_ms').notNull().default(120000),
		priority: integer('priority').notNull().default(100),
		enabled: boolean('enabled').notNull().default(true),
		healthStatus: text('health_status').notNull().default('unknown'),
		config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('connection_provider_slug_idx').on(t.providerId, t.slug)]
);

// One account = one credential row (spec §4). `secretEnc` uses the S0 envelope:
// base64(iv[12] || ct || tag[16]), AES-256-GCM, CREDENTIALS_MASTER_KEY. The
// plaintext is one account JSON; raw secrets never leave the backend (PRD §92,
// §136).
export const credential = pgTable(
	'credential',
	{
		id: text('id').primaryKey(),
		connectionId: text('connection_id')
			.notNull()
			.references(() => connection.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		secretEnc: text('secret_enc').notNull(),
		status: text('status').notNull().default('unknown'),
		priority: integer('priority').notNull().default(100),
		weight: integer('weight').notNull().default(100),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
		lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
		lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
		cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('credential_connection_idx').on(t.connectionId),
		index('credential_status_idx').on(t.status),
		index('credential_last_validated_idx').on(t.lastValidatedAt.asc().nullsFirst(), t.id)
	]
);

// ---------------------------------------------------------------- catalog -----
// PRD §57–59: canonical models, provider mappings, aliases (§35–36).

export const providerModel = pgTable(
	'provider_model',
	{
		id: text('id').primaryKey(),
		modelId: text('model_id')
			.notNull()
			.references(() => model.id, { onDelete: 'cascade' }),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id, { onDelete: 'cascade' }),
		connectionId: text('connection_id').references(() => connection.id, {
			onDelete: 'set null'
		}),
		providerModelId: text('provider_model_id').notNull(),
		enabled: boolean('enabled').notNull().default(true),
		capabilitiesOverride: jsonb('capabilities_override')
			.$type<Record<string, boolean>>()
			.notNull()
			.default({}),
		contextOverride: integer('context_override'),
		status: text('status').notNull().default('available'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		// Target uniqueness is the COALESCE expression index
		// "provider_model_target_idx" in 0006_platform_schema.sql
		// (model_id, provider_id, COALESCE(connection_id, '')) — connection_id
		// NULL means "any connection" and NULLs are distinct in a plain index.
		index('provider_model_provider_idx').on(t.providerId)
	]
);

// account_id NULL = the global `fudrouter/*` virtual models (PRD §36).
export const modelAlias = pgTable('model_alias', {
	id: text('id').primaryKey(),
	accountId: text('account_id').references(() => user.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	enabled: boolean('enabled').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	// Scope+name uniqueness is the COALESCE expression index
	// "model_alias_scope_name_idx" in 0019 (COALESCE(account_id,''), name) —
	// the NULL scope (global virtuals) must collide on name too.
});

export const modelAliasTarget = pgTable(
	'model_alias_target',
	{
		aliasId: text('alias_id')
			.notNull()
			.references(() => modelAlias.id, { onDelete: 'cascade' }),
		modelId: text('model_id')
			.notNull()
			.references(() => model.id, { onDelete: 'cascade' }),
		position: integer('position').notNull()
	},
	(t) => [primaryKey({ columns: [t.aliasId, t.position] })]
);

// Evidence of what a provider actually served, one row per completed probe
// (0018_model_verification.sql). Append-only like request_log: the latest
// verdict is a max-by-created_at read, never an UPDATE — a verdict is evidence
// from a point in time, not a mutable property. SET NULL on mapping delete so
// erasing a mapping keeps the record that the provider once served the wrong
// model (the survive-the-subject rule request_log's ledger columns follow).
export const modelVerification = pgTable(
	'model_verification',
	{
		id: text('id').primaryKey(),
		providerModelId: text('provider_model_id').references(() => providerModel.id, {
			onDelete: 'set null'
		}),
		requestedSlug: text('requested_slug').notNull(),
		responseModel: text('response_model'),
		verdict: text('verdict').notNull(),
		error: text('error'),
		tokensIn: integer('tokens_in'),
		tokensOut: integer('tokens_out'),
		latencyMs: integer('latency_ms'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('model_verification_provider_model_idx').on(t.providerModelId, t.createdAt)]
);

// ---------------------------------------------------------------- pricing -----
// PRD §60–61: versioned, immutable history. A new price is a NEW ROW; the old
// one gets effectiveUntil. Prices are micro-units of currency per 1M tokens.
export const pricingRule = pgTable(
	'pricing_rule',
	{
		id: text('id').primaryKey(),
		modelId: text('model_id')
			.notNull()
			.references(() => model.id, { onDelete: 'cascade' }),
		providerModelId: text('provider_model_id'),
		version: integer('version').notNull().default(1),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		inputPrice: numeric('input_price', { precision: 18, scale: 6 }).notNull(),
		cachedInputPrice: numeric('cached_input_price', { precision: 18, scale: 6 }),
		outputPrice: numeric('output_price', { precision: 18, scale: 6 }).notNull(),
		reasoningPrice: numeric('reasoning_price', { precision: 18, scale: 6 }),
		effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
		effectiveUntil: timestamp('effective_until', { withTimezone: true }),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		// Version uniqueness is the COALESCE expression index
		// "pricing_rule_version_idx" in 0006_platform_schema.sql
		// (model_id, COALESCE(provider_model_id,''), version) — model-wide and
		// provider-specific rules version independently.
		index('pricing_rule_model_effective_idx').on(t.modelId, t.effectiveFrom)
	]
);

// ---------------------------------------------------- keys / limits / budget ---
// PRD §40–41: limits per scope. Effective limit = min across the chain
// platform -> workspace -> project -> environment -> api_key (spec §7).
export const rateLimit = pgTable(
	'rate_limit',
	{
		id: text('id').primaryKey(),
		scope: text('scope').notNull(),
		scopeId: text('scope_id').notNull(),
		rpm: integer('rpm'),
		tpm: bigint('tpm', { mode: 'number' }),
		rpd: integer('rpd'),
		tpd: bigint('tpd', { mode: 'number' }),
		concurrency: integer('concurrency'),
		dailySpendMicro: bigint('daily_spend_micro', { mode: 'bigint' }),
		monthlySpendMicro: bigint('monthly_spend_micro', { mode: 'bigint' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('rate_limit_scope_idx').on(t.scope, t.scopeId)]
);

// PRD §40: thresholds at warn/critical/100%. Valkey counts, PostgreSQL aggregates.
export const budget = pgTable(
	'budget',
	{
		id: text('id').primaryKey(),
		scope: text('scope').notNull(),
		scopeId: text('scope_id').notNull(),
		period: text('period').notNull(),
		amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
		warnPercent: integer('warn_percent').notNull().default(70),
		criticalPercent: integer('critical_percent').notNull().default(90),
		actionAt100: text('action_at_100').notNull().default('block'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('budget_scope_idx').on(t.scope, t.scopeId, t.period)]
);

// --------------------------------------------------------------- requests -----
// PRD §8, §29: one request, N routing attempts. Append-only.
export const requestAttempt = pgTable(
	'request_attempt',
	{
		id: text('id').primaryKey(),
		requestId: text('request_id')
			.notNull()
			.references(() => requestLog.id, { onDelete: 'cascade' }),
		attempt: integer('attempt').notNull(),
		providerId: text('provider_id'),
		connectionId: text('connection_id'),
		credentialId: text('credential_id'),
		providerModelId: text('provider_model_id'),
		httpStatus: integer('http_status'),
		errorCode: text('error_code'),
		retryable: boolean('retryable'),
		latencyMs: integer('latency_ms').notNull().default(0),
		ttftMs: integer('ttft_ms'),
		providerCostMicro: bigint('provider_cost_micro', { mode: 'bigint' }),
		reason: text('reason'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({})
	},
	(t) => [
		unique('request_attempt_request_attempt_unique').on(t.requestId, t.attempt),
		index('request_attempt_request_idx').on(t.requestId, t.attempt)
	]
);

// PRD §96–97: aggregates the long-range dashboards read instead of raw rows.
// Dimensions that do not apply to a row are NULL; the unique index COALESCEs
// them ('' sentinel) because NULLs are distinct.
export const usageHourly = pgTable('usage_hourly', {
	bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
	accountId: text('account_id'),
	apiKeyId: text('api_key_id'),
	modelId: text('model_id'),
	providerId: text('provider_id'),
	connectionId: text('connection_id'),
	status: text('status').notNull(),
	endpoint: text('endpoint').notNull(),
	requests: bigint('requests', { mode: 'number' }).notNull().default(0),
	successes: bigint('successes', { mode: 'number' }).notNull().default(0),
	tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
	cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' })
		.notNull()
		.default(0),
	tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
	reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
	totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
	costMicro: bigint('cost_micro', { mode: 'bigint' })
		.notNull()
		.default(sql`0`),
	latencyMsSum: bigint('latency_ms_sum', { mode: 'number' }).notNull().default(0),
	latencyHistogram: jsonb('latency_histogram')
		.$type<Record<string, number>>()
		.notNull()
		.default({}),
	ttftMsSum: bigint('ttft_ms_sum', { mode: 'number' }).notNull().default(0),
	fallbackCount: bigint('fallback_count', { mode: 'number' }).notNull().default(0),
	retryCount: bigint('retry_count', { mode: 'number' }).notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	// Dimension-tuple uniqueness is the COALESCE expression index
	// "usage_hourly_dims_idx" in 0006_platform_schema.sql (every NULL dimension
	// coalesced to '' so "unset" collapses into one bucket row, not N).
});

// Same shape as usage_hourly; bucket_start = day start in UTC.
export const usageDaily = pgTable('usage_daily', {
	bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
	accountId: text('account_id'),
	apiKeyId: text('api_key_id'),
	modelId: text('model_id'),
	providerId: text('provider_id'),
	connectionId: text('connection_id'),
	status: text('status').notNull(),
	endpoint: text('endpoint').notNull(),
	requests: bigint('requests', { mode: 'number' }).notNull().default(0),
	successes: bigint('successes', { mode: 'number' }).notNull().default(0),
	tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
	cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' })
		.notNull()
		.default(0),
	tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
	reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
	totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
	costMicro: bigint('cost_micro', { mode: 'bigint' })
		.notNull()
		.default(sql`0`),
	latencyMsSum: bigint('latency_ms_sum', { mode: 'number' }).notNull().default(0),
	latencyHistogram: jsonb('latency_histogram')
		.$type<Record<string, number>>()
		.notNull()
		.default({}),
	ttftMsSum: bigint('ttft_ms_sum', { mode: 'number' }).notNull().default(0),
	fallbackCount: bigint('fallback_count', { mode: 'number' }).notNull().default(0),
	retryCount: bigint('retry_count', { mode: 'number' }).notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	// COALESCE expression index "usage_daily_dims_idx" in
	// 0006_platform_schema.sql — see usageHourly.
});

// ----------------------------------------------------------------- billing -----
// PRD §47–48, §128–129: ledger, never a bare balance. balanceMicro is a cache
// of SUM(credit_ledger.amount_micro), reconcilable at any time.
export const billingAccount = pgTable(
	'billing_account',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		status: text('status').notNull().default('active'),
		warningThresholdMicro: bigint('warning_threshold_micro', { mode: 'bigint' })
			.notNull()
			.default(sql`10000000`),
		hardStopThresholdMicro: bigint('hard_stop_threshold_micro', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		balanceMicro: bigint('balance_micro', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('billing_account_user_idx').on(t.userId)]
);

export const creditLedger = pgTable(
	'credit_ledger',
	{
		id: text('id').primaryKey(),
		billingAccountId: text('billing_account_id')
			.notNull()
			.references(() => billingAccount.id, { onDelete: 'cascade' }),
		type: text('type').notNull(),
		amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		requestId: text('request_id'),
		// Idempotency is DURABLE (PRD §118): the unique index below is the
		// stopper for double-charges (`usage:{request_id}`), Valkey is only a
		// fast-path hint. NULL = not an idempotent write (several rows may be
		// NULL — the index allows it).
		idempotencyKey: text('idempotency_key'),
		description: text('description'),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('credit_ledger_idempotency_idx').on(t.idempotencyKey),
		index('credit_ledger_account_created_idx').on(t.billingAccountId, t.createdAt)
	]
);

export const invoice = pgTable(
	'invoice',
	{
		id: text('id').primaryKey(),
		billingAccountId: text('billing_account_id')
			.notNull()
			.references(() => billingAccount.id, { onDelete: 'cascade' }),
		number: text('number').notNull(),
		periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
		periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
		amountMicro: bigint('amount_micro', { mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		status: text('status').notNull().default('draft'),
		issuedAt: timestamp('issued_at', { withTimezone: true }),
		paidAt: timestamp('paid_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('invoice_number_idx').on(t.number)]
);

// --------------------------------------------------------------- operations ----
// PRD §42–43, §63, §70–77, §104–105, §19.

export const alert = pgTable(
	'alert',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		condition: jsonb('condition').$type<Record<string, unknown>>().notNull().default({}),
		channel: text('channel').notNull().default('inapp'),
		enabled: boolean('enabled').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('alert_account_idx').on(t.accountId)]
);

export const alertEvent = pgTable(
	'alert_event',
	{
		id: text('id').primaryKey(),
		alertId: text('alert_id')
			.notNull()
			.references(() => alert.id, { onDelete: 'cascade' }),
		triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
		value: numeric('value').notNull(),
		message: text('message').notNull().default(''),
		state: text('state').notNull().default('firing'),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		deliveredAt: timestamp('delivered_at', { withTimezone: true })
	},
	(t) => [index('alert_event_alert_idx').on(t.alertId, t.triggeredAt)]
);

export const webhook = pgTable(
	'webhook',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		url: text('url').notNull(),
		secretEnc: text('secret_enc'),
		events: jsonb('events').$type<string[]>().notNull().default([]),
		enabled: boolean('enabled').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('webhook_account_idx').on(t.accountId)]
);

export const webhookDelivery = pgTable(
	'webhook_delivery',
	{
		id: text('id').primaryKey(),
		webhookId: text('webhook_id')
			.notNull()
			.references(() => webhook.id, { onDelete: 'cascade' }),
		event: text('event').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		responseCode: integer('response_code'),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		deliveredAt: timestamp('delivered_at', { withTimezone: true })
	},
	(t) => [index('webhook_delivery_pending_idx').on(t.status, t.nextAttemptAt)]
);

// PRD §75: PostgreSQL is the durable queue; workers claim with SKIP LOCKED.
export const job = pgTable(
	'job',
	{
		id: text('id').primaryKey(),
		type: text('type').notNull(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(5),
		availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('job_claim_idx').on(t.status, t.availableAt)]
);

// PRD §77: durable observability/workflow events — NOT an event bus.
export const systemEvent = pgTable(
	'system_event',
	{
		id: text('id').primaryKey(),
		type: text('type').notNull(),
		resource: text('resource'),
		resourceId: text('resource_id'),
		workspaceId: text('workspace_id'),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('system_event_type_created_idx').on(t.type, t.createdAt),
		index('system_event_created_idx').on(t.createdAt)
	]
);

// PRD §71, §137: append-only in application code. Secrets are redacted at
// write time — never in before/after/metadata.
export const auditLog = pgTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		actorUserId: text('actor_user_id'),
		actorKind: text('actor_kind').notNull().default('user'),
		action: text('action').notNull(),
		resource: text('resource').notNull(),
		resourceId: text('resource_id'),
		workspaceId: text('workspace_id'),
		ip: text('ip'),
		before: jsonb('before').$type<Record<string, unknown>>(),
		after: jsonb('after').$type<Record<string, unknown>>(),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('audit_log_created_idx').on(t.createdAt),
		index('audit_log_resource_idx').on(t.resource, t.resourceId),
		index('audit_log_workspace_idx').on(t.workspaceId)
	]
);

// PRD §19: status page incidents with a timeline.
export const incident = pgTable(
	'incident',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		component: text('component').notNull(),
		severity: text('severity').notNull().default('minor'),
		status: text('status').notNull().default('investigating'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('incident_status_idx').on(t.status, t.startedAt)]
);

export const incidentUpdate = pgTable(
	'incident_update',
	{
		id: text('id').primaryKey(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incident.id, { onDelete: 'cascade' }),
		status: text('status').notNull(),
		message: text('message').notNull().default(''),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('incident_update_incident_idx').on(t.incidentId, t.createdAt)]
);

// PRD §104: simple flags in PostgreSQL, cached in Valkey. No external service.
export const featureFlag = pgTable(
	'feature_flag',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		enabled: boolean('enabled').notNull().default(false),
		rollout: jsonb('rollout').$type<Record<string, unknown>>().notNull().default({}),
		updatedBy: text('updated_by'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('feature_flag_name_idx').on(t.name)]
);

// PRD §70: rule-based abuse signals (no ML).
export const securityRule = pgTable(
	'security_rule',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		kind: text('kind').notNull(),
		config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
		enabled: boolean('enabled').notNull().default(true),
		action: text('action').notNull().default('log'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('security_rule_name_idx').on(t.name)]
);

// PRD §63, §105, §138: runtime breaker CONFIG lives in PostgreSQL (state is
// Valkey-only and may vanish, spec §12); platform settings are a kv of jsonb.
export const circuitBreaker = pgTable(
	'circuit_breaker',
	{
		id: text('id').primaryKey(),
		target: text('target').notNull(),
		targetId: text('target_id').notNull(),
		failureThreshold: integer('failure_threshold').notNull().default(5),
		windowSeconds: integer('window_seconds').notNull().default(60),
		openMs: integer('open_ms').notNull().default(30000),
		halfOpenProbes: integer('half_open_probes').notNull().default(2),
		enabled: boolean('enabled').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('circuit_breaker_target_idx').on(t.target, t.targetId)]
);

export const systemSetting = pgTable('system_setting', {
	key: text('key').primaryKey(),
	value: jsonb('value').$type<unknown>().notNull().default(sql`'null'::jsonb`),
	updatedBy: text('updated_by'),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export { user, session, account, verification } from './auth.schema.ts';
