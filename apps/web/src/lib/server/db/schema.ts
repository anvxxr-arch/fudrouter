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
	index,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

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
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
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
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('provider_name_idx').on(t.name)]
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
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('model_slug_idx').on(t.slug)]
);

// request_log — append-only, highest-volume table. cost = micro-units of currency.
export const requestLog = pgTable(
	'request_log',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		apiKeyId: text('api_key_id')
			.notNull()
			.references(() => apiKey.id, { onDelete: 'cascade' }),
		modelId: text('model_id')
			.notNull()
			.references(() => model.id),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id),
		tokensIn: integer('tokens_in').notNull().default(0),
		tokensOut: integer('tokens_out').notNull().default(0),
		cost: bigint('cost', { mode: 'bigint' }).notNull().default(sql`0`),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		latencyMs: integer('latency_ms').notNull().default(0),
		status: text('status').notNull(),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('request_log_user_created_idx').on(t.userId, t.createdAt),
		index('request_log_api_key_created_idx').on(t.apiKeyId, t.createdAt)
	]
);

export { user, session, account, verification } from './auth.schema';
