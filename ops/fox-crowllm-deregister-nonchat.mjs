#!/usr/bin/env node
// ops/fox-crowllm-deregister-nonchat.mjs — stop advertising non-chat models on the chat surface.
//
// catalog.go (§37-49) is explicit: the catalogue IS the chat surface, and publishing
// embedding/rerank rows there costs the user a 400 they discover by asking. crowllm's
// catalogue mixes 7 embed-* and 5 rerank-* ids in with the chat models, so those
// provider_model rows are disabled here. The shared `model` rows are left alone —
// another provider may legitimately serve the same slug.
//
// Reversible: pass --enable to flip them back.
//
// Usage: set -a && . .env && set +a && node ops/fox-crowllm-deregister-nonchat.mjs
import postgres from 'postgres';

const ENABLE = process.argv.includes('--enable');
const PROVIDER_ID = 'prv_crowllm';

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const rows = await sql`
      select pm.id, m.slug
      from provider_model pm join model m on m.id = pm.model_id
      where pm.provider_id = ${PROVIDER_ID}
        and (m.slug like 'embed-%' or m.slug like 'rerank-%')`;
    console.log(`non-chat provider_models found: ${rows.length}`);
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    if (ENABLE) {
      await sql`update provider_model set enabled = true, status = 'available', updated_at = now() where id = any(${ids})`;
      console.log(`re-enabled: ${ids.length}`);
    } else {
      await sql`update provider_model set enabled = false, status = 'disabled', updated_at = now() where id = any(${ids})`;
      console.log(`disabled: ${ids.length}`);
    }
    const [c] = await sql`
      select count(*)::int n from provider_model pm join model m on m.id = pm.model_id
      where pm.provider_id = ${PROVIDER_ID} and pm.enabled and m.slug not like 'embed-%' and m.slug not like 'rerank-%'`;
    console.log(`chat-servable provider_models for ${PROVIDER_ID}: ${c.n}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
