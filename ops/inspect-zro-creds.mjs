#!/usr/bin/env node
/**
 * ops/inspect-zro-creds.mjs — read-only: show stored creds for given email prefixes.
 * Usage: node ops/inspect-zro-creds.mjs prefix1 prefix2 ...
 */
import postgres from 'postgres';

const prefixes = process.argv.slice(2);
if (!prefixes.length) {
	console.error('usage: inspect-zro-creds.mjs <emailPrefix>...');
	process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`
	select cr.id, cr.name, cr.status, cr.cooldown_until::text as cd,
	       length(cr.secret_enc) as enc_len, cr.last_validated_at::text as lv
	from credential cr
	join connection cn on cn.id = cr.connection_id
	where cn.provider_id = 'prv_zro'
	  and (${prefixes.map((p) => sql`cr.name like ${p + '%'}`).reduce((a, b) => sql`${a} or ${b}`)})
	order by cr.name`;
console.log(`rows: ${rows.length}`);
for (const r of rows) {
	console.log(`${r.name.slice(0, 16).padEnd(17)} ${String(r.status).padEnd(13)} cd=${r.cd ?? '-'} enc=${r.enc_len} lv=${r.lv ?? '-'}`);
}
await sql.end();
