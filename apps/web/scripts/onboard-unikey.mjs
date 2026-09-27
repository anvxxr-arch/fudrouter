#!/usr/bin/env node
// Onboard UniKey to fudrouter: 48 API keys, OpenAI-compatible, no refresh needed.
// Usage: node --env-file=apps/web/.env scripts/onboard-unikey.mjs
import postgres from 'postgres';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from '../src/lib/server/provider-status.ts';

const KEY_FILE = '/home/dwizzy/.hermes/cache/documents/doc_99ebe3069425_unikey_tuyul_keys.txt';
const PROVIDER_ID = 'unikey';
const PROVIDER_NAME = 'UniKey';
const BASE_URL = 'https://www.getunikey.ai/v1';

const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const json = JSON.stringify(obj);
	const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, ct, tag]).toString('base64');
}

// The `model.input_price`/`output_price` columns are MICRO-USD per 1M tokens
// (1 USD = 1e6 micro-USD); the model table below is written in plain USD per 1M.
// Every price written must go through this or the router bills 1e-6 of list.
const usdToMicro = (usd) => Math.round(Number(usd) * 1_000_000).toString();

// `provider.status` is the operator's call: this only seeds a NEW row, and
// rewrites an existing one when UNIKEY_PROVIDER_STATUS is set explicitly.
const { value: STATUS, isExplicit: STATUS_EXPLICIT } = resolveStatus('UNIKEY_PROVIDER_STATUS');
assertValidStatus(STATUS, 'UNIKEY_PROVIDER_STATUS');

try {
	// Read keys
	const keys = (await import('node:fs'))
		.readFileSync(KEY_FILE, 'utf8')
		.split('\n')
		.filter((l) => l.trim().startsWith('sk-'))
		.map((l) => l.trim());
	console.log(`loaded ${keys.length} keys`);

	// Build credential blob: static API keys (no refresh)
	const accounts = keys.map((k, i) => ({
		email: `unikey-key-${i + 1}@getunikey.ai`,
		api_key: k,
		refresh_token: null, // static key, no refresh
		access_token: k,
		expired: '2099-01-01T00:00:00Z' // far future, never refresh
	}));

	const cred = {
		api_key: keys[0], // fallback
		auth_kind: 'apikey',
		default_headers: {},
		accounts
	};

	const enc = encrypt(cred);

	// Upsert provider
	await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${enc}, ${STATUS}, 150)
    ${providerUpsertConflict('id', STATUS, STATUS_EXPLICIT)}`;
	console.log(`provider ${PROVIDER_ID} upserted (${statusLogSuffix(STATUS, STATUS_EXPLICIT)})`);

	// Upsert models (28 chat models from UniKey catalog)
	const models = [
		// xAI
		{ slug: 'x-ai/grok-4.3', name: 'Grok 4.3', input: 2.0, output: 6.0, context: 500000 },
		// DeepSeek
		{
			slug: 'deepseek/deepseek-v4-pro',
			name: 'DeepSeek V4 Pro',
			input: 0.27,
			output: 1.0,
			context: 128000
		},
		{
			slug: 'deepseek/deepseek-v4-flash',
			name: 'DeepSeek V4 Flash',
			input: 0.07,
			output: 0.27,
			context: 128000
		},
		{
			slug: 'deepseek-v4-pro',
			name: 'DeepSeek V4 Pro (alt)',
			input: 0.27,
			output: 1.0,
			context: 128000
		},
		{
			slug: 'deepseek-v4-flash',
			name: 'DeepSeek V4 Flash (alt)',
			input: 0.07,
			output: 0.27,
			context: 128000
		},
		// Anthropic
		{
			slug: 'claude-haiku-4-5-20251001',
			name: 'Claude Haiku 4.5',
			input: 0.8,
			output: 4.0,
			context: 200000
		},
		{
			slug: 'claude-opus-4-6',
			name: 'Claude Opus 4.6',
			input: 15.0,
			output: 75.0,
			context: 200000
		},
		{
			slug: 'claude-opus-4-7',
			name: 'Claude Opus 4.7',
			input: 15.0,
			output: 75.0,
			context: 200000
		},
		{
			slug: 'claude-opus-4-8',
			name: 'Claude Opus 4.8',
			input: 15.0,
			output: 75.0,
			context: 200000
		},
		// OpenAI
		{ slug: 'gpt-5.5', name: 'GPT-5.5', input: 1.25, output: 10.0, context: 128000 },
		{ slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: 1.25, output: 10.0, context: 128000 },
		{ slug: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: 1.25, output: 10.0, context: 128000 },
		{ slug: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', input: 1.25, output: 10.0, context: 128000 },
		{ slug: 'gpt-6-astra', name: 'GPT-6 Astra', input: 1.25, output: 10.0, context: 128000 },
		// Alibaba/Qwen
		{ slug: 'qwen3.7-max', name: 'Qwen3.7 Max', input: 0.27, output: 1.0, context: 128000 },
		// Google
		{
			slug: 'google/gemini-3.5-flash',
			name: 'Gemini 3.5 Flash',
			input: 0.1,
			output: 0.4,
			context: 1000000
		},
		{
			slug: 'google/gemini-3.1-pro-preview',
			name: 'Gemini 3.1 Pro',
			input: 1.25,
			output: 5.0,
			context: 1000000
		},
		{
			slug: 'gemini-3.5-flash',
			name: 'Gemini 3.5 Flash (alt)',
			input: 0.1,
			output: 0.4,
			context: 1000000
		},
		{
			slug: 'gemini-3.1-pro',
			name: 'Gemini 3.1 Pro (alt)',
			input: 1.25,
			output: 5.0,
			context: 1000000
		},
		// Moonshot
		{
			slug: 'moonshotai/kimi-k2.7-code',
			name: 'Kimi K2.7 Code',
			input: 0.27,
			output: 1.0,
			context: 128000
		},
		{ slug: 'moonshotai/kimi-k3', name: 'Kimi K3', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'kimi-k2.6', name: 'Kimi K2.6', input: 0.27, output: 1.0, context: 128000 },
		{
			slug: 'kimi-k2.7-code',
			name: 'Kimi K2.7 Code (alt)',
			input: 0.27,
			output: 1.0,
			context: 128000
		},
		{ slug: 'kimi-k3', name: 'Kimi K3 (alt)', input: 0.27, output: 1.0, context: 128000 },
		// Z-AI
		{ slug: 'z-ai/glm-5.1', name: 'GLM-5.1', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'z-ai/glm-5.2', name: 'GLM-5.2', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'glm-5.1', name: 'GLM-5.1 (alt)', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'glm-5.2', name: 'GLM-5.2 (alt)', input: 0.27, output: 1.0, context: 128000 },
		// MiniMax
		{ slug: 'minimax/minimax-m3', name: 'MiniMax M3', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'minimax/hailuo-3', name: 'Hailuo 3', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'MiniMax-M2.7', name: 'MiniMax M2.7', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'MiniMax-M3', name: 'MiniMax M3 (alt)', input: 0.27, output: 1.0, context: 128000 },
		{ slug: 'minimax-m3', name: 'MiniMax M3 (alt)', input: 0.27, output: 1.0, context: 128000 },
		// Image generation
		{
			slug: 'google/gemini-3.1-flash-image',
			name: 'Gemini 3.1 Flash Image',
			input: 0.1,
			output: 0.4,
			context: 1000000
		},
		// Embeddings
		{ slug: 'BAAI/bge-m3', name: 'BGE-M3 Embeddings', input: 0.0, output: 0.0, context: 8192 }
	];

	for (const m of models) {
		// `input`/`output` above are USD per 1M tokens; the column is MICRO-USD per
		// 1M (1 USD = 1e6 micro-USD). Writing the raw dollar value made the router
		// bill 1e-6 of list price and the pricing page render every model as $0.00.
		await sql`
      insert into model (id, slug, name, provider_id, input_price, output_price, context)
      values (${crypto.randomUUID()}, ${m.slug}, ${m.name}, ${PROVIDER_ID}, ${usdToMicro(m.input)}, ${usdToMicro(m.output)}, ${m.context})
      on conflict (slug) do update set
        name = excluded.name,
        provider_id = excluded.provider_id,
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        context = excluded.context
    `;
	}
	console.log(`${models.length} models upserted`);

	console.log('\n✅ UniKey onboarded. Restart router to load pool.');
} finally {
	await sql.end();
}
