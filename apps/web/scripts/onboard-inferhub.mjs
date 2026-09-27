#!/usr/bin/env node
// Onboard InferHub (https://api.inferhub.dev) to fudrouter.
//
// InferHub is an [OI]-compatible marketplace: providers bid to serve a model,
// and a request is matched against a max-per-mtok bid. It is therefore a plain
// [OI] passthrough for the data plane — no protocol shim needed.
//
// Usage:
//   INFERHUB_API_KEY=sk-airo-... node --env-file=apps/web/.env apps/web/scripts/onboard-inferhub.mjs
//   INFERHUB_API_KEY_FILE=keys.txt          # one static key per line (pool)
//   ... --dry-run                           # fetch + report, write nothing
//
// The catalog is fetched LIVE from GET /v1/models (it carries per-model
// `pricing.official_in` / `official_out` and `input_token_limit`), so the seeded
// rows always match what the gateway actually advertises.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { encryptCredentials } from '../src/lib/server/credentials.ts';

const PROVIDER_ID = process.env.INFERHUB_PROVIDER_ID || 'inferhub';
const PROVIDER_NAME = 'InferHub';
const BASE_URL = (process.env.INFERHUB_BASE_URL || 'https://api.inferhub.dev/v1').replace(
	/\/+$/,
	''
);
// 'active': every onboarded upstream is a commercial arrangement (confirmed
// 2026-09-26). `dev` is spec §1's label for a provider that must not ship, so a
// commercial one has no reason to carry it. Override with the env var when
// deliberately onboarding a non-commercial upstream.
const STATUS = process.env.INFERHUB_PROVIDER_STATUS || 'active';
const PRIORITY = Number(process.env.INFERHUB_PROVIDER_PRIORITY || 170);
const DRY = process.argv.includes('--dry-run');

// The upstream reports `pricing.official_in`/`official_out` in USD per 1M tokens,
// but `model.input_price`/`output_price` are MICRO-USD per 1M (1 USD = 1e6
// micro-USD). Inserting the raw dollar value made the router bill 1e-6 of list
// price and the pricing page render every InferHub model as $0.00.
const usdToMicro = (usd) => Math.round(Number(usd ?? 0) * 1_000_000).toString();

function loadKeys() {
	const out = [];
	if (process.env.INFERHUB_API_KEY_FILE) {
		out.push(
			...readFileSync(process.env.INFERHUB_API_KEY_FILE, 'utf8')
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean)
		);
	}
	for (const v of [process.env.INFERHUB_API_KEY, process.env.INFERHUB_API_KEYS]) {
		if (v)
			out.push(
				...v
					.split(/[\s,]+/)
					.map((s) => s.trim())
					.filter(Boolean)
			);
	}
	return [...new Set(out)];
}

const keys = loadKeys();
if (keys.length === 0) {
	console.error('No key. Set INFERHUB_API_KEY (sk-airo-...) or INFERHUB_API_KEY_FILE.');
	process.exit(1);
}
console.log(`loaded ${keys.length} key(s)`);

// 1. fetch the live catalog
const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${keys[0]}` } });
if (!res.ok) {
	console.error(`GET ${BASE_URL}/models -> HTTP ${res.status}`);
	process.exit(1);
}
const body = await res.json();
const raw = Array.isArray(body?.data) ? body.data : [];

// Namespace placeholders (id ends with '/', e.g. `ag/`, `cb/`) are not callable
// models — seeding them would advertise a slug that always fails.
const models = raw.filter(
	(m) => typeof m?.id === 'string' && m.id.trim() !== '' && !m.id.endsWith('/')
);
const skippedNs = raw.length - models.length;
console.log(
	`catalog: ${raw.length} entries, ${models.length} callable models (${skippedNs} namespace placeholders skipped)`
);

if (DRY) {
	console.log('\n--dry-run: no writes.');
	console.log(
		`provider: ${PROVIDER_ID} (${PROVIDER_NAME}) base_url=${BASE_URL} status=${STATUS} priority=${PRIORITY}`
	);
	for (const m of models) {
		const p = m.pricing || {};
		const inP = p.official_in ?? 0;
		const outP = p.official_out ?? 0;
		console.log(`  ${m.id.padEnd(42)} in=${inP} out=${outP} ctx=${m.input_token_limit ?? '-'}`);
	}
	process.exit(0);
}

// Static keys never refresh — `expired` must be far future (a null/absent value
// triggers a refresh that cannot succeed and parks the account).
const accounts = keys.map((k, i) => ({
	email: `inferhub-key-${i + 1}@inferhub.dev`,
	api_key: k,
	access_token: k,
	refresh_token: null,
	expired: '2099-01-01T00:00:00Z'
}));
const cred = { api_key: keys[0], auth_kind: 'apikey', default_headers: {}, accounts };

const sql = postgres(process.env.DATABASE_URL);
try {
	const enc = encryptCredentials(cred);
	await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority)
		values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${enc}, ${STATUS}, ${PRIORITY})
		on conflict (id) do update set
			name = excluded.name,
			base_url = excluded.base_url,
			credentials_enc = excluded.credentials_enc,
			status = excluded.status,
			priority = excluded.priority
	`;
	console.log(`provider ${PROVIDER_ID} upserted (status=${STATUS})`);

	// `model.slug` is UNIQUE table-wide: the `where` clause makes a slug owned by
	// another provider a no-op instead of reassigning (and later cascading) it.
	let upserted = 0;
	const collided = [];
	for (const m of models) {
		const p = m.pricing || {};
		const inP = p.official_in ?? 0;
		const outP = p.official_out ?? 0;
		const ctx = Number.isFinite(m.input_token_limit) ? m.input_token_limit : null;
		const rows = await sql`
			insert into model (id, slug, name, provider_id, input_price, output_price, context)
			values (${randomUUID()}, ${m.id}, ${m.id}, ${PROVIDER_ID}, ${usdToMicro(inP)}, ${usdToMicro(outP)}, ${ctx})
			on conflict (slug) do update set
				name = excluded.name,
				input_price = excluded.input_price,
				output_price = excluded.output_price,
				context = excluded.context
			where model.provider_id = ${PROVIDER_ID}
			returning id
		`;
		if (rows.length) upserted++;
		else collided.push(m.id);
	}
	console.log(`${upserted} models upserted`);
	if (collided.length) {
		console.warn(
			`skipped ${collided.length} model(s) owned by another provider: ${collided.slice(0, 12).join(', ')}${collided.length > 12 ? ` …+${collided.length - 12}` : ''}`
		);
	}

	console.log(
		'\n✅ InferHub onboarded. Restart the router only if re-onboarding an existing pool:'
	);
	console.log('   pm2 restart fudrouter-router');
} finally {
	await sql.end();
}
