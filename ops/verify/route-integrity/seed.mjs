#!/usr/bin/env node
// Seed the route-integrity drill database and mint its API key.
//
// Self-contained on purpose: it used to shell out to `git show 2362648^:apps/web/
// scripts/dev-api-key.mjs` to mint the key and wrote a provider/model pair in the
// S0 shape. Both broke as the schema moved on — the key script lived in the
// deleted Svelte app, and the router's candidate query now walks
// model -> provider_model -> connection -> credential, so a provider+model with
// no connection and no provider_model rows yields ZERO candidates and every
// drill test fails for a reason unrelated to credential failover.
//
// Shape, one provider per scenario (keys are the mock upstream's behaviour
// switch — see mock_upstream.py):
//
//   ftest-ok    [live]            control
//   ftest-dl    [dead, live]      failover past a 401  — router SHOULD serve 200
//   ftest-rl    [rl,   live]      failover past a 429  — today it does NOT
//   ftest-br    [br,   live]      failover past a 503  — today it does NOT
//   ftest-dead  [dead1, dead2]    clean bounded failure
//   ftest-drop  [drop, live]      failover past a transport error
//
// Env: DATABASE_URL must point at the SCRATCH db (this script refuses the
// production database by name), CREDENTIALS_MASTER_KEY is read from the root
// .env so the blob decrypts with the same key the router holds. DEV_KEY_OUT
// (optional) writes the minted key to that path with mode 600.
import postgres from 'postgres';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const DSN = process.env.DATABASE_URL || '';
if (!DSN) {
	console.error('DATABASE_URL required (scratch db)');
	process.exit(1);
}
if (/\/fudrouter$/.test(DSN)) {
	console.error('refusing to touch the production database');
	process.exit(1);
}

const envFile = readFileSync('/home/dwizzy/fudrouter/.env', 'utf8');
const kmLine = envFile.split('\n').find((l) => l.startsWith('CREDENTIALS_MASTER_KEY='));
if (!kmLine) {
	console.error('CREDENTIALS_MASTER_KEY not found in /home/dwizzy/fudrouter/.env');
	process.exit(1);
}
const master = Buffer.from(kmLine.slice('CREDENTIALS_MASTER_KEY='.length).trim(), 'base64');

function encrypt(obj) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', master, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

// One account per credential ROW, stored FLAT — spec §4 / `accountFromSecret`.
// A pooled `{accounts:[...]}` blob is what the drill used to write, but the data
// plane parses the flat form, so that blob decrypts to an unusable credential.
const acct = (email, key) => ({
	email,
	api_key: key,
	refresh_token: null,
	access_token: key,
	expired: '2099-01-01T00:00:00Z'
});

const UPSTREAM = 'http://127.0.0.1:8201/v1';
// [slug, name, [[email, key], ...] ordered best-last so a dead account is tried first]
const PROVIDERS = [
	['ftest-ok', 'FT Control', [['live@ftest', 'ft-key-live']]],
	['ftest-dl', 'FT DeadFirst', [['dead@ftest', 'ft-key-dead'], ['live@ftest', 'ft-key-live']]],
	['ftest-rl', 'FT RateLimited', [['rl@ftest', 'ft-key-rl'], ['live@ftest', 'ft-key-live']]],
	['ftest-br', 'FT Broken', [['br@ftest', 'ft-key-br'], ['live@ftest', 'ft-key-live']]],
	['ftest-dead', 'FT AllDead', [['dead1@ftest', 'ft-key-dead'], ['dead2@ftest', 'ft-key-dead']]],
	['ftest-drop', 'FT DropFirst', [['drop@ftest', 'ft-key-drop'], ['live@ftest', 'ft-key-live']]]
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randChars(n) {
	const b = randomBytes(n);
	let s = '';
	for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
	return s;
}

const sql = postgres(DSN);
try {
	await sql.begin(async (tx) => {
		for (const [slug, name, accounts] of PROVIDERS) {
			const provId = `prv_${slug}`;
			const connId = `con_${slug}`;
			const modelId = `ft-m-${slug}`;
			await tx`
				insert into provider (id, name, slug, base_url, credentials_enc, status, tier, enabled, priority)
				values (${provId}, ${name}, ${slug}, ${UPSTREAM}, '', 'active', 'commercial', true, 100)
				on conflict (id) do update set
					name = excluded.name, slug = excluded.slug, base_url = excluded.base_url,
					status = 'active', tier = 'commercial', enabled = true`;
			await tx`
				insert into connection (id, provider_id, name, slug, base_url, auth_type, enabled, health_status)
				values (${connId}, ${provId}, 'default', 'default', ${UPSTREAM}, 'bearer', true, 'healthy')
				on conflict (id) do update set
					provider_id = excluded.provider_id, base_url = excluded.base_url,
					enabled = true, health_status = 'healthy'`;
			await tx`delete from credential where connection_id = ${connId}`;
			let prio = 1;
			for (const [email, key] of accounts) {
				await tx`
					insert into credential (id, connection_id, name, secret_enc, status, priority, weight)
					values (${`cred_${slug}_${prio}`}, ${connId}, ${email}, ${encrypt(acct(email, key))}, 'healthy', ${prio}, 100)`;
				prio += 1;
			}
			await tx`
				insert into model (id, provider_id, name, slug, input_price, output_price, currency, status)
				values (${modelId}, ${provId}, ${slug}, ${slug}, 0, 0, 'USD', 'active')
				on conflict (id) do update set
					provider_id = excluded.provider_id, slug = excluded.slug, status = 'active'`;
			await tx`
				insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
				values (${`pmdl_${slug}`}, ${modelId}, ${provId}, ${connId}, ${slug}, true, 'available')
				on conflict (id) do update set
					model_id = excluded.model_id, provider_id = excluded.provider_id,
					connection_id = excluded.connection_id, provider_model_id = excluded.provider_model_id,
					enabled = true, status = 'available'`;
		}

		// Mint a drill API key. `sk-ar-<8 prefix>_<32 secret>`, sha256(secret) only.
		const prefix = randChars(8);
		const secret = randChars(32);
		const keyHash = createHash('sha256').update(secret, 'utf8').digest('hex');
		const email = 'drill@fudrouter.local';
		await tx`
			insert into "user" (id, name, email, email_verified, role, created_at, updated_at)
			values (${'u_' + randChars(12)}, 'ftest', ${email}, true, 'admin', now(), now())
			on conflict (email) do update set updated_at = now()`;
		const [u] = await tx`select id from "user" where email = ${email}`;
		await tx`delete from api_key where user_id = ${u.id}`;
		await tx`
			insert into api_key (id, user_id, name, prefix, key_hash, limits, created_at)
			values (${randomUUID()}, ${u.id}, 'ftest', ${prefix}, ${keyHash}, '{}'::jsonb, now())`;
		const full = `sk-ar-${prefix}_${secret}`;
		const out = process.env.DEV_KEY_OUT;
		if (out) {
			writeFileSync(out, full, { mode: 0o600 });
			console.log(`key written to ${out} (mode 600)`);
		} else {
			console.log(full);
		}

		const [{ p }] = await tx`select count(*)::int as p from provider where id like 'prv_ftest-%'`;
		const [{ c }] = await tx`select count(*)::int as c from credential where connection_id like 'con_ftest-%'`;
		const [{ m }] = await tx`select count(*)::int as m from provider_model where id like 'pmdl_ftest-%'`;
		console.log(`seeded ${p} providers, ${c} credentials, ${m} provider_models`);
	});
} finally {
	await sql.end();
}
