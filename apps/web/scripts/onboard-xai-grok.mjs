// Usage: node --env-file=.env scripts/onboard-xai-grok.mjs
//
// Onboards the xAI Grok upstream into `provider` + `model`, sourcing credentials
// from the grok-register farm's cpa_auths directory.
//
// Why the shape is what it is:
//   - The Go data plane (store.ModelWithProvider -> proxy) reads p.base_url and
//     p.credentials_enc, decrypts, and sends `Authorization: Bearer <api_key>` to
//     `TrimRight(base_url,"/") + "/chat/completions"`. So base_url MUST include /v1.
//   - The upstream rejects requests without `x-grok-client-version` (it answers
//     "Your Grok CLI version (none) is outdated"). That header is recorded in
//     `default_headers` so the data plane can honour it instead of hardcoding it.
//   - One provider row holds the whole account pool: `model.slug` is UNIQUE, so all
//     models must hang off a single provider.
//
// Idempotent: re-running replaces the credential blob and re-upserts the models.
import postgres from 'postgres';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDER_NAME = process.env.XAI_PROVIDER_NAME || 'xai-grok';
const BASE_URL = process.env.XAI_BASE_URL || 'https://cli-chat-proxy.grok.com/v1';
const AUTH_DIR = process.env.GROK_FARM_AUTH_DIR || '/home/dwizzy/grok-register/cpa_auths';
const CLI_VERSION = process.env.XAI_CLI_VERSION || '0.1.202';
const PRIORITY = Number(process.env.XAI_PRIORITY || 10);

// Published list prices, micro-USD per 1M tokens (1 USD = 1e6 micro-USD).
// Source: https://docs.x.ai/developers/models — grok-4.6 is $2.00 in / $6.00 out.
// grok-4.7 is served by the upstream but is NOT in the published table, so it
// inherits the flagship rate. Confirm before S2 turns these into real billing.
const MODELS = [
	{ slug: 'grok-4.6', name: 'Grok 4.6', context: 500000, input: '2000000.000000', output: '6000000.000000' },
	{ slug: 'grok-4.7', name: 'Grok 4.7', context: 500000, input: '2000000.000000', output: '6000000.000000' }
];

const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
if (!MASTER) { console.error('missing env: CREDENTIALS_MASTER_KEY'); process.exit(1); }
if (!DSN) { console.error('missing env: DATABASE_URL'); process.exit(1); }

function encrypt(plain) {
	const key = Buffer.from(MASTER, 'base64');
	if (key.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

if (!existsSync(AUTH_DIR)) {
	console.error(`auth dir not found: ${AUTH_DIR}`);
	process.exit(1);
}

// ---- load the credential pool (dedupe by email, newest expiry wins) ----
const byEmail = new Map();
for (const f of readdirSync(AUTH_DIR)) {
	if (!f.startsWith('xai-') || !f.endsWith('.json')) continue;
	let d;
	try {
		d = JSON.parse(readFileSync(join(AUTH_DIR, f), 'utf8'));
	} catch {
		continue;
	}
	if (!d.access_token || !d.email) continue;
	const prev = byEmail.get(d.email);
	if (!prev || String(d.expired || '') > String(prev.expired || '')) {
		byEmail.set(d.email, {
			email: d.email,
			access_token: d.access_token,
			refresh_token: d.refresh_token || '',
			id_token: d.id_token || '',
			expired: d.expired || ''
		});
	}
}
const accounts = [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
if (!accounts.length) {
	console.error(`no usable credentials found in ${AUTH_DIR}`);
	process.exit(1);
}

const creds = {
	api_key: accounts[0].access_token,
	auth_kind: 'oauth',
	default_headers: { 'x-grok-client-version': CLI_VERSION },
	accounts
};

const sql = postgres(DSN);
try {
	const rows = await sql`
		insert into provider (id, name, base_url, credentials_enc, status, priority)
		values (${crypto.randomUUID()}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(creds)}, 'active', ${PRIORITY})
		on conflict (name) do update
		  set base_url = excluded.base_url,
		      credentials_enc = excluded.credentials_enc,
		      status = 'active',
		      priority = excluded.priority
		returning id`;
	const pid = rows[0].id;

	for (const m of MODELS) {
		await sql`
			insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
			values (${crypto.randomUUID()}, ${pid}, ${m.name}, ${m.slug}, ${m.context},
			        ${m.input}, ${m.output}, 'USD', 'active')
			on conflict (slug) do update
			  set provider_id = excluded.provider_id,
			      name = excluded.name,
			      context = excluded.context,
			      input_price = excluded.input_price,
			      output_price = excluded.output_price,
			      status = 'active'`;
	}

	// ---- report (never echoes a token) ----
	const check = await sql`
		select p.name, p.base_url, p.status, p.priority, length(p.credentials_enc) enc_len,
		       count(m.id)::int models
		from provider p left join model m on m.provider_id = p.id
		where p.name = ${PROVIDER_NAME}
		group by p.name, p.base_url, p.status, p.priority, p.credentials_enc`;

	console.log(`onboarded provider "${PROVIDER_NAME}"`);
	console.log(`  base_url     : ${check[0].base_url}`);
	console.log(`  status       : ${check[0].status} (priority ${check[0].priority})`);
	console.log(`  credentials  : ${check[0].enc_len} chars ciphertext, ${accounts.length} accounts`);
	console.log(`  models       : ${check[0].models}`);
	console.log(`  expiries     : ${accounts[0].expired} .. ${accounts[accounts.length - 1].expired}`);
} finally {
	await sql.end();
}
