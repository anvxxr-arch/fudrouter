// Usage: node --env-file=.env scripts/seed.mjs
// Idempotently upserts one provider + one model from SEED_* env vars.
import postgres from 'postgres';
import { createCipheriv, randomBytes } from 'node:crypto';

const required = [
	'DATABASE_URL',
	'CREDENTIALS_MASTER_KEY',
	'SEED_PROVIDER_NAME',
	'SEED_PROVIDER_BASE_URL',
	'SEED_PROVIDER_API_KEY',
	'SEED_MODEL_SLUG',
	'SEED_MODEL_NAME',
	'SEED_MODEL_INPUT_PRICE',
	'SEED_MODEL_OUTPUT_PRICE',
	'SEED_MODEL_CURRENCY'
];
for (const k of required) {
	if (!process.env[k]) {
		console.error(`missing env: ${k}`);
		process.exit(1);
	}
}

function encrypt(plain) {
	const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
	if (key.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const sql = postgres(process.env.DATABASE_URL);
const providerId = crypto.randomUUID();
const modelId = crypto.randomUUID();

const provider = await sql`
	insert into provider (id, name, base_url, credentials_enc, status, priority)
	values (${providerId}, ${process.env.SEED_PROVIDER_NAME}, ${process.env.SEED_PROVIDER_BASE_URL},
	        ${encrypt({ api_key: process.env.SEED_PROVIDER_API_KEY })}, 'active', 100)
	on conflict (name) do update
	  set base_url = excluded.base_url,
	      credentials_enc = excluded.credentials_enc,
	      status = 'active'
	returning id`;
const pid = provider[0].id;

const model = await sql`
	insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
	values (${modelId}, ${pid}, ${process.env.SEED_MODEL_NAME}, ${process.env.SEED_MODEL_SLUG},
	        128000, ${process.env.SEED_MODEL_INPUT_PRICE}, ${process.env.SEED_MODEL_OUTPUT_PRICE},
	        ${process.env.SEED_MODEL_CURRENCY}, 'active')
	on conflict (slug) do update
	  set provider_id = excluded.provider_id,
	      name = excluded.name,
	      input_price = excluded.input_price,
	      output_price = excluded.output_price,
	      currency = excluded.currency,
	      status = 'active'
	returning id, slug`;

console.log(
	`seeded: provider ${process.env.SEED_PROVIDER_NAME} (${pid}), model ${model[0].slug} (${model[0].id})`
);
await sql.end();
