#!/usr/bin/env node
// Onboard free.ai (api.free.ai) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-freeai.mjs [accounts.jsonl]
//
// Key source: the harvester's jsonl, one JSON object per line with `email`/`api_key`.
// Only rows carrying a well-formed `sk-` key qualify.
//
// Provider id follows spec §1 (0007_platform_backfill): wrapped as `prv_<legacy>`,
// matching what merge-freeai-keys.mjs resolves.
//
// Catalog note: api.free.ai advertises ~400 ids but serves only the ones flagged
// `self_hosted: true` (everything else answers 400 "not served by this endpoint"),
// so the catalog is filtered before probing — probing the dead 400 would just burn
// the run's time budget.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
	resolveStatus,
	assertValidStatus,
	providerUpsertConflict,
	statusLogSuffix
} from '../src/lib/server/provider-status.ts';

const KEYS_FILE =
	process.argv[2] || '/home/dwizzy/.hermes/cache/scratch/freeai_x/out/freeai_accounts.jsonl';
const LEGACY_ID = 'freeai';
const PROVIDER_ID = 'prv_' + LEGACY_ID;
const PROVIDER_NAME = 'FreeAI';
const PROVIDER_SLUG = 'freeai';
const BASE_URL = 'https://api.free.ai/v1';
const PRIORITY = 171;

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
	let rec;
	try {
		rec = JSON.parse(line);
	} catch {
		continue;
	}
	const key = rec?.api_key;
	if (typeof key !== 'string' || !key.startsWith('sk-') || seen.has(key)) continue;
	seen.add(key);
	accounts.push({
		email: rec.email || `freeai-key-${key.slice(-6)}@free.ai`,
		api_key: key,
		refresh_token: null,
		access_token: key,
		expired: '2099-01-01T00:00:00Z'
	});
}
console.log(`keys file: ${KEYS_FILE} (${lines} lines) | usable sk- keys: ${accounts.length}`);
if (!accounts.length) {
	console.error('no usable keys (need jsonl rows carrying `api_key`: sk-…)');
	process.exit(1);
}

const key = accounts[0].api_key;
const { value: STATUS, isExplicit: STATUS_EXPLICIT } = resolveStatus('FREEAI_PROVIDER_STATUS');
assertValidStatus(STATUS, 'FREEAI_PROVIDER_STATUS');

try {
	const mr = await fetch(BASE_URL + '/models', {
		headers: { Authorization: 'Bearer ' + key },
		signal: AbortSignal.timeout(30000)
	});
	if (!mr.ok) {
		console.error(`catalog fetch HTTP ${mr.status} — refusing to onboard blind`);
		process.exit(1);
	}
	// Shape guard: free.ai answers `{"models": [...]}` (not the OpenAI `{"data": []}`),
	// so read either key — a silent empty catalog would onboard the pool with zero
	// models and look like "nothing to do".
	const payload = await mr.json();
	const catalog = payload.data ?? payload.models ?? [];
	const selfHosted = catalog.filter((m) => m.self_hosted === true);
	if (!catalog.length) {
		console.error('catalog came back empty — refusing to onboard without models');
		process.exit(1);
	}
	console.log(`catalog: ${catalog.length} ids, ${selfHosted.length} self-hosted (the rest 400)`);

	const models = [];
	for (const m of selfHosted) {
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
			context: m.context_window || m.context_length || 32768,
			status: served ? 'active' : 'inactive',
			served
		});
	}
	console.log('catalog:');
	for (const m of models) console.log(`  ${m.status.padEnd(8)} ${m.slug} (served now: ${m.served})`);

	const cred = { api_key: key, auth_kind: 'apikey', default_headers: {}, accounts };
	// `providerUpsertConflict` returns a SQL *string*; interpolating a string into a
	// tagged template makes it a bound parameter (`$8`), so the clause must be spliced
	// with sql.unsafe and positional params.
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
	console.log(`${models.length} models + ${models.length} provider_model rows upserted\n✅ free.ai onboarded.`);
} finally {
	await sql.end();
}
