// Cek baseUrl + jumlah koneksi provider TokenHarbor di fudrouter (nilai kredensial TIDAK dicetak).
// jalan dari apps/web:  node --env-file=.env scripts/th-provider-check.mjs
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);
const ids = ['prv_tokenharbor', 'tokenharbor'];
const [prov] = await sql`select id, slug, coalesce(status,'-') as status, credentials_enc from provider where id in ${sql(ids)} limit 1`;
if (!prov) {
	console.log('provider tokenharbor TIDAK ADA');
	process.exit(0);
}
const [c] = await sql`select count(*)::int as n from connection where provider_id = ${prov.id}`;
const [pm] = await sql`select count(*)::int as n from provider_model where provider_id = ${prov.id} and enabled`;
const conns = await sql`select config from connection where provider_id = ${prov.id} limit 3`;
console.log(`provider=${prov.id} slug=${prov.slug} status=${prov.status} connections=${c.n} provider_model=${pm.n}`);
for (const r of conns) {
	const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {});
	const out = { ...cfg };
	for (const k of ['apiKey', 'api_key', 'key', 'token', 'password', 'credentials']) if (k in out) out[k] = '[REDACTED]';
	console.log('  conn config:', JSON.stringify(out).slice(0, 400));
}
// credentials_enc hanya bentuknya saja
const b = Buffer.from(prov.credentials_enc ?? '', 'base64');
console.log(`  credentials_enc: ${b.length} bytes (tidak didekripsi)`);
await sql.end();
