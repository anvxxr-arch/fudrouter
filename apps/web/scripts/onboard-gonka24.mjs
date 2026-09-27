#!/usr/bin/env node
// Onboard Gonka24 (api.gonka24.com, Firebase-auth frontend) to fudrouter.
// Usage: node --env-file=apps/web/.env scripts/onboard-gonka24.mjs [keys.json]
//
// Farm accounts are gated on email verification: the $10 signup credit only
// lands once the Firebase oobCode is redeemed (see gonka24_farmer.py), so the
// keys file carries `working: true` only for accounts that passed the smoke
// test. Those get the far-future expiry the router uses for static keys.
//
// Model availability is probed live: a slug the network does not serve right
// now lands inactive and the admin can flip it later.
import postgres from 'postgres';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEYS_FILE = process.argv[2] || '/home/dwizzy/gonka24-automator/gonka24_keys.json';
const PROVIDER_ID = 'gonka24';
const PROVIDER_NAME = 'Gonka24';
const BASE_URL = 'https://api.gonka24.com/v1';

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
	.filter((a) => a && typeof a.api_key === 'string' && a.api_key.startsWith('sk-') && a.working === true)
	.map((a) => ({
		email: a.email || `gonka24-key-${a.api_key.slice(-6)}@gonka24`,
		api_key: a.api_key,
		refresh_token: null,
		access_token: a.api_key,
		expired: '2099-01-01T00:00:00Z'
	}));
console.log(`keys file: ${accountsRaw.length} entries | verified+working: ${accounts.length}`);
if (!accounts.length) {
	console.error('no usable keys (need working: true records)');
	process.exit(1);
}

const key = accounts[0].access_token;

try {
	const mr = await fetch(BASE_URL + '/models', { headers: { Authorization: 'Bearer ' + key } });
	const catalog = (await mr.json()).data;
	const models = [];
	for (const m of catalog) {
		// Probe one tiny completion: Gonka miners come and go per model.
		let served = false;
		try {
			const pr = await fetch(BASE_URL + '/chat/completions', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
				signal: AbortSignal.timeout(30000)
			});
			served = pr.status === 200;
			if (!served) console.log(`  probe ${m.id}: HTTP ${pr.status} ${(await pr.text()).slice(0, 80)}`);
		} catch (e) {
			console.log(`  probe ${m.id}: ${String(e).slice(0, 80)}`);
		}
		models.push({
			slug: m.id,
			name: m.id.replace(/[-_]/g, ' '),
			input: 0,
			output: 0,
			context: m.context_window || m.context_length || 128000,
			status: served ? 'active' : 'inactive',
			served
		});
	}
	console.log('catalog:');
	for (const m of models) console.log(`  ${m.status.padEnd(8)} ${m.slug} (served now: ${m.served})`);

	const cred = { api_key: key, auth_kind: 'apikey', default_headers: {}, accounts };
	const p = await sql`
    insert into provider (id, name, base_url, credentials_enc, status, priority)
    values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${encrypt(cred)}, 'active', 167)
    on conflict (id) do update set
      name = excluded.name,
      base_url = excluded.base_url,
      credentials_enc = excluded.credentials_enc,
      priority = excluded.priority
    returning id`;
	if (p.count !== 1) {
		console.error(`provider upsert matched ${p.count} rows`);
		process.exit(1);
	}
	console.log(`provider ${PROVIDER_ID} upserted with ${accounts.length} keys`);

	for (const m of models) {
		// model.slug is UNIQUE table-wide: never steal a slug owned by another
		// provider (that would silently re-point their traffic at Gonka24).
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
	console.log(`${models.length} models upserted\n✅ Gonka24 onboarded.`);
} finally {
	await sql.end();
}
