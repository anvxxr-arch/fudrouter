#!/usr/bin/env node
// Onboard Top-Tools-AI (top-tools-ai.com — Clerk + Turnstile frontend) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-tt.mjs [credentials.txt]
//
// Key source: the farm ledger, one line per account — `email | password | sk-… | ts`.
// Only rows carrying a well-formed `sk-…` key qualify; the password column is not
// needed (the key is static with a far-future expiry, like the other farm pools).
//
// Provider id follows spec §1 (0007_platform_backfill): ids are wrapped as
// `prv_<legacy>`. The matching merge script resolves the same pair, so a rename of
// either side cannot silently stop the pool from growing.
//
// Model availability is probed live — a slug the network does not serve today
// (TT answers 402 "Insufficient pay-as-you-go balance" for three flagship ids)
// lands inactive and the operator can flip it later.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from '../src/lib/server/provider-status.ts';

const KEYS_FILE = process.argv[2] || '/home/dwizzy/projects/tt_farm/out/credentials.txt';
const LEGACY_ID = 'tt';
const PROVIDER_ID = 'prv_' + LEGACY_ID;
const PROVIDER_NAME = 'Top-Tools-AI';
const PROVIDER_SLUG = 'tt';
const BASE_URL = 'https://top-tools-ai.com/api/v1';
const PRIORITY = 169;

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
if (master.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
const sql = postgres(process.env.DATABASE_URL);

function encrypt(obj) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', master, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const seen = new Set();
const accounts = [];
let lines = 0;
for (const raw of readFileSync(KEYS_FILE, 'utf8').split('\n')) {
	const line = raw.trim();
	if (!line) continue;
	lines++;
	const parts = line.split('|').map((s) => s.trim());
	if (parts.length < 3) continue;
	const email = parts[0];
	const key = parts[2];
	if (!key || !key.startsWith('sk-') || seen.has(key)) continue;
	seen.add(key);
	accounts.push({
		email: email || `tt-key-${key.slice(-6)}@top-tools-ai`,
		api_key: key,
		refresh_token: null,
		access_token: key,
		expired: '2099-01-01T00:00:00Z'
	});
}
console.log(`keys file: ${KEYS_FILE} (${lines} lines) | usable sk- keys: ${accounts.length}`);
if (!accounts.length) {
	console.error('no usable keys (need the `email | password | sk-… | ts` shape)');
	process.exit(1);
}

const key = accounts[0].api_key;
const { value: STATUS, isExplicit: STATUS_EXPLICIT } = resolveStatus('TT_PROVIDER_STATUS');
assertValidStatus(STATUS, 'TT_PROVIDER_STATUS');

try {
	const mr = await fetch(BASE_URL + '/models', {
		headers: { Authorization: 'Bearer ' + key },
		signal: AbortSignal.timeout(30000)
	});
	if (!mr.ok) {
		console.error(`catalog fetch HTTP ${mr.status} — refusing to onboard blind`);
		process.exit(1);
	}
	const catalog = (await mr.json()).data ?? [];
	const models = [];
	for (const m of catalog) {
		let served = false;
		try {
			const pr = await fetch(BASE_URL + '/chat/completions', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: m.id,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 4
				}),
				signal: AbortSignal.timeout(45000)
			});
			served = pr.status === 200;
			if (!served) console.log(`  probe ${m.id}: HTTP ${pr.status} ${(await pr.text()).slice(0, 80)}`);
		} catch (e) {
			console.log(`  probe ${m.id}: ${String(e).slice(0, 80)}`);
		}
		models.push({
			slug: m.id,
			name: m.id.replace(/[-_]/g, ' '),
			context: m.context_window || m.context_length || 128000,
			status: served ? 'active' : 'inactive',
			served
		});
	}
	console.log('catalog:');
	for (const m of models) console.log(`  ${m.status.padEnd(8)} ${m.slug} (served now: ${m.served})`);

	const cred = { api_key: key, auth_kind: 'apikey', default_headers: {}, accounts };
	// `providerUpsertConflict` returns a SQL *string*; interpolating a string into a
	// tagged template makes it a bound parameter (`$8`), so the clause must be spliced
	// with sql.unsafe and positional params — the same trap the other onboard scripts
	// hit ("syntax error at or near $8").
	const conflictClause = providerUpsertConflict('id', STATUS, STATUS_EXPLICIT);
	const p = await sql.unsafe(
		`insert into provider (id, name, slug, base_url, credentials_enc, status, priority)
     values ($1, $2, $3, $4, $5, $6, $7) ${conflictClause}`,
		[PROVIDER_ID, PROVIDER_NAME, PROVIDER_SLUG, BASE_URL, encrypt(cred), STATUS, PRIORITY]
	);
	if (p.count !== 1) {
		console.error(`provider upsert matched ${p.count} rows`);
		process.exit(1);
	}
	console.log(
		`provider ${PROVIDER_ID} upserted with ${accounts.length} keys (${statusLogSuffix(STATUS, STATUS_EXPLICIT)})`
	);

	const CONNECTION_ID = 'con_' + PROVIDER_ID + '-default';
	const c = await sql`
    insert into connection (id, provider_id, name, slug, base_url, auth_type, timeout_ms, priority, enabled, health_status, config)
    values (${CONNECTION_ID}, ${PROVIDER_ID}, ${PROVIDER_NAME}, 'default', ${BASE_URL}, 'bearer', 120000, 100, true, 'healthy', '{"auth_kind":"apikey","default_headers":{}}'::jsonb)
    on conflict (id) do update set
      base_url = excluded.base_url,
      enabled = true,
      health_status = 'healthy'
    returning id`;
	if (!c.count) {
		console.error(`connection upsert matched ${c.count} rows`);
		process.exit(1);
	}
	console.log(`connection ${CONNECTION_ID} ready`);

	for (const m of models) {
		// model.slug is UNIQUE table-wide: never steal a slug owned by another
		// provider (that would silently re-point their traffic at Top-Tools-AI).
		const [owner] = await sql`select provider_id from model where slug = ${m.slug}`;
		if (owner && owner.provider_id !== PROVIDER_ID) {
			console.warn(`  SKIP ${m.slug} — slug already owned by ${owner.provider_id}`);
			continue;
		}
		const [mrow] = await sql`
      insert into model (id, slug, name, provider_id, input_price, output_price, context, status)
      values (${'mdl_' + randomUUID()}, ${m.slug}, ${m.name}, ${PROVIDER_ID}, 0, 0, ${m.context}, ${m.status})
      on conflict (slug) do update set
        name = excluded.name,
        provider_id = excluded.provider_id,
        context = excluded.context,
        status = excluded.status
      returning id`;
		if (!mrow) {
			console.error(`model upsert for ${m.slug} matched 0 rows`);
			process.exit(1);
		}
		// A `model` row alone is not routable: the router builds its candidate list
		// from `provider_model` (join on model_id and pm.enabled — catalog.go), which
		// also carries the upstream id actually sent to the provider.
		const pm = await sql`
      insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, status)
      values (${'pmdl_' + mrow.id}, ${mrow.id}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.slug}, true, '{}'::jsonb, 'available')
      on conflict (id) do update set
        provider_model_id = excluded.provider_model_id,
        enabled = true,
        status = 'available'
      returning id`;
		if (!pm.count) {
			console.error(`provider_model upsert for ${m.slug} matched 0 rows`);
			process.exit(1);
		}
	}
	const [{ n }] = await sql`select count(*)::int as n from provider_model where provider_id = ${PROVIDER_ID} and enabled`;
	console.log(
		`${n} routable models + ${n} provider_model rows live for ${PROVIDER_ID}` +
			` (probed ${models.length}, rest skipped: slug owned elsewhere)\n✅ Top-Tools-AI onboarded.`
	);
} finally {
	await sql.end();
}
