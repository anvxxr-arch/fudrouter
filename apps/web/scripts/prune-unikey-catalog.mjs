#!/usr/bin/env node
// Hide the UniKey models a low-balance key cannot serve.
//
// UniKey pre-deducts an estimated cost before every request and keys carry only
// ~2.5 credits, so any model priced above that answers 403
// `insufficient_user_quota`. Advertising those slugs makes the router hand out
// models that always fail. The model row is kept (request_log has an FK to it)
// and only its `status` is flipped to 'inactive', which the data plane already
// filters on (`m.status = 'active'`).
//
// Usage: node --env-file=apps/web/.env apps/web/scripts/prune-unikey-catalog.mjs
import postgres from 'postgres';

const PROVIDER_ID = 'unikey';
// Verified live against a ~2.5-credit key: the zero-cost chat model and the
// embeddings model are the only two that pass the pre-deduct gate.
const KEEP = ['deepseek/deepseek-v4-flash', 'BAAI/bge-m3'];

const sql = postgres(process.env.DATABASE_URL);
try {
	const rows = await sql`select slug, status from model where provider_id = ${PROVIDER_ID}`;
	const hide = rows.filter((r) => !KEEP.includes(r.slug) && r.status === 'active');
	console.log(`unikey models: ${rows.length}, keeping ${KEEP.length}, hiding ${hide.length}`);
	for (const r of hide) console.log(`  - ${JSON.stringify(r.slug)}`);

	if (hide.length) {
		await sql`
      update model set status = 'inactive'
      where provider_id = ${PROVIDER_ID}
        and slug <> all(${sql.array(KEEP)})
        and status = 'active'`;
	}

	const left = await sql`
    select slug, name, status from model
    where provider_id = ${PROVIDER_ID} order by status, slug`;
	console.log(`\nunikey catalog (${left.length}):`);
	for (const r of left) console.log(`  [${r.status}] ${r.slug}  ${r.name}`);
} finally {
	await sql.end();
}
