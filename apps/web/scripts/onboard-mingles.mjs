#!/usr/bin/env node
// Onboard Mingles (router.mingles.ai, Gonka marketplace) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-mingles.mjs [keys.json]
//
// Keys are static `sk-` values minted per farmed account (a free tier of ~4M
// tokens/week per account, no refresh), so they get the far-future expiry the
// router uses for non-refreshable credentials. The account email is real (the
// farm creates it) — keep it, it names the account in router logs.
//
// Model availability on Gonka is time-varying ("No upstream serves model X"),
// so the seed probes each slug first: one 200 now => published, otherwise the
// row lands inactive and the admin can flip it when the network serves it.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from '../src/lib/server/provider-status.ts';

const KEYS_FILE = process.argv[2] || '/home/dwizzy/mingles-router-farmer/mingles_keys.json';
const PROVIDER_ID = 'mingles';
const PROVIDER_NAME = 'Mingles';
const BASE_URL = 'https://router.mingles.ai/v1';

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', master, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const accountsRaw = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
const accounts = accountsRaw
	.filter((a) => a && typeof a.key === 'string' && a.key.startsWith('sk-'))
	.map((a) => ({
		email: a.email || `mingles-key-${a.key.slice(-6)}@mingles`,
		api_key: a.key,
		refresh_token: null,
		access_token: a.key,
		expired: '2099-01-01T00:00:00Z'
	}));
console.log(`keys file: ${accountsRaw.length} entries | usable: ${accounts.length}`);
if (!accounts.length) {
	console.error('no usable keys');
	process.exit(1);
}

const key = accounts[0].access_token;
const probeFile = '/home/dwizzy/.hermes/cache/scratch/mingles-probe2.json';
const probe = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, 'utf8')) : {};

// `provider.status` is the operator's call: this only seeds a NEW row, and
// rewrites an existing one when MINGLES_PROVIDER_STATUS is set explicitly.
const { value: STATUS, isExplicit: STATUS_EXPLICIT } = resolveStatus('MINGLES_PROVIDER_STATUS');
assertValidStatus(STATUS, 'MINGLES_PROVIDER_STATUS');

try {
	// --- live catalog (id + context_window), probed for current availability ---
	const mr = await fetch(BASE_URL + '/models', { headers: { Authorization: 'Bearer ' + key } });
	const catalog = (await mr.json()).data;
	const models = [];
	for (const m of catalog) {
		const tried = probe[m.id];
		const served = Array.isArray(tried) ? tried.some((t) => t.status === 200) : null;
		models.push({
			slug: m.id,
			name: m.id.split('/').pop().replace(/-/g, ' '),
			input: 0,
			output: 0,
			context: m.context_window || 128000,
			status: served === false ? 'inactive' : 'active',
			served
		});
	}
	console.log('catalog:');
	for (const m of models)
		console.log(`  ${m.status.padEnd(8)} ${m.slug} (served now: ${m.served})`);

	const cred = { api_key: key, auth_kind: 'apikey', default_headers: {}, accounts };
	const p = await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, ${STATUS}, 165)
    ${providerUpsertConflict('id', STATUS, STATUS_EXPLICIT)}`;
	if (p.count !== 1) {
		console.error(`provider upsert matched ${p.count} rows`);
		process.exit(1);
	}
	console.log(
		`provider ${PROVIDER_ID} upserted with ${accounts.length} keys (${statusLogSuffix(STATUS, STATUS_EXPLICIT)})`
	);

	for (const m of models) {
		// model.slug is UNIQUE table-wide: never steal a slug owned by another
		// provider (that would silently re-point their traffic at Mingles).
		const [owner] = await sql`select provider_id from model where slug = ${m.slug}`;
		if (owner && owner.provider_id !== PROVIDER_ID) {
			console.warn(`  SKIP ${m.slug} — slug already owned by ${owner.provider_id}`);
			continue;
		}
		const r = await sql`
      insert into model (id, slug, name, provider_id, input_price, output_price, context, status)
      values (${randomUUID()}, ${m.slug}, ${m.name}, ${PROVIDER_ID}, ${m.input}, ${m.output}, ${m.context}, ${m.status})
      on conflict (slug) do update set
        name = excluded.name,
        provider_id = excluded.provider_id,
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        context = excluded.context
      returning id`;
		if (!r.count) {
			console.error(`model upsert for ${m.slug} matched 0 rows`);
			process.exit(1);
		}
	}
	console.log(`${models.length} models upserted\n✅ Mingles onboarded.`);
} finally {
	await sql.end();
}
