#!/usr/bin/env node
// ops/onboard-crowllm-models.mjs — register crowllm's :free catalogue as routable models.
//
// model.slug is GLOBALLY unique in this schema (model_slug_idx), and the same upstream
// model is already registered by other providers (prv_openrouter, prv_cline,
// prv_tokenharbor...). So the correct mapping is: one shared `model` row per slug,
// one `provider_model` row per (provider, connection) pointing at it. Creating a
// second model row for a colliding slug violates model_slug_idx — that is not a
// reason to rename the wire id, it means attach to the existing model.
//
// Catalogue has no context/price metadata (only id + owned_by), so price is 0/0 and
// context stays null; provider_model_id is the upstream id verbatim, INCLUDING the
// ":free" suffix (it is part of the wire name).
//
// Idempotent on both tables; re-running only re-enables provider_model.
//
// Usage: set -a && . .env && set +a && node ops/onboard-crowllm-models.mjs [catalog.json]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const PROVIDER_ID = 'prv_crowllm';
const CONNECTION_ID = 'con_prv_crowllm-default';
const FILE = process.argv[2] ?? '/home/dwizzy/.hermes/cache/scratch/crowllm_free_catalog.json';

function title(id) {
  const base = id.replace(/:free$/, '');
  return base
    .split(/[-_/]/)
    .map((p) => (p.length <= 3 && /^[a-z0-9.]+$/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bLlm\b/g, 'LLM')
    .replace(/\bVl\b/g, 'VL');
}

const newMdlId = (slug) => 'mdl_' + createHash('sha256').update(`${PROVIDER_ID}:${slug}`).digest('hex').slice(0, 32);
const pmId = (slug) => 'pmdl_' + createHash('sha256').update(`${PROVIDER_ID}:pm:${slug}`).digest('hex').slice(0, 32);

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const cat = JSON.parse(readFileSync(FILE, 'utf8'));
    console.log(`catalogue entries: ${cat.length}`);
    let modelsNew = 0, shared = 0, pmsNew = 0, pmRe = 0;

    for (const m of cat) {
      const slug = m.id;
      // 1) attach to an existing model row when this slug is already known
      const found = await sql`select id from model where slug = ${slug} limit 1`;
      let mid;
      if (found.length > 0) {
        mid = found[0].id;
        shared++;
      } else {
        mid = newMdlId(slug);
        await sql`
          insert into model (id, provider_id, name, slug, status, developer, description, capabilities, input_price, output_price)
          values (${mid}, ${PROVIDER_ID}, ${title(slug)}, ${slug}, 'active',
                  ${m.owned_by ?? null}, ${'crowllm free tier: ' + (m.owned_by ?? 'unknown')},
                  ${sql.json({ streaming: true, tools: true, vision: /vl|vision|omni|4v/i.test(slug) })},
                  0, 0)
          on conflict (id) do update set status = 'active', updated_at = now()`;
        modelsNew++;
      }

      // 2) wire it to the crowllm connection
      const r2 = await sql`
        insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
        values (${pmId(slug)}, ${mid}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${slug}, true, 'available')
        on conflict (id) do update set enabled = true, status = 'available', updated_at = now()
        returning (xmax = 0) as inserted`;
      if (r2[0]?.inserted) pmsNew++; else pmRe++;
    }
    console.log(`model rows: ${modelsNew} created, ${shared} attached to an existing shared slug`);
    console.log(`provider_models: ${pmsNew} new, ${pmRe} re-enabled`);

    const [c] = await sql`select count(*)::int n from provider_model where provider_id = ${PROVIDER_ID} and enabled=true`;
    console.log(`registry now: ${c.n} enabled provider_models for ${PROVIDER_ID}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
