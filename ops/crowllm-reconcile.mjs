#!/usr/bin/env node
/**
 * crowllm-reconcile.mjs — close the gap between what crowllm serves and what the
 * router will actually hand out.
 *
 * Two defects this repairs, both found by comparing the upstream /v1/models list
 * against the registry and then probing every live link through the router:
 *
 *   A. UNREGISTERED. crowllm advertises :free slugs we have no row for, so callers
 *      cannot reach them at all (19 of them at time of writing, incl. gemini-3.8-flash,
 *      gpt-5.6-sol, o3, qwen-3.8-max).
 *
 *   B. INACTIVE SHARED ROW. `model.slug` is globally UNIQUE, so a slug already owned
 *      by another provider shares that row. onboard-crowllm-models.mjs only ATTACHES
 *      when the slug exists — it never revives the row — so a slug whose owner left it
 *      status='inactive' stays hidden from the router and answers MODEL_NOT_FOUND even
 *      though our link is enabled and the upstream serves it. `model.status` is a
 *      single global column: any provider that deactivates a shared row silently
 *      breaks every other provider wired to the same slug.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   node ops/crowllm-reconcile.mjs            # report
 *   node ops/crowllm-reconcile.mjs --apply    # fix
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const PROVIDER_ID = 'prv_crowllm';
const CONNECTION_ID = 'con_prv_crowllm-default';
const APPLY = process.argv.includes('--apply');
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NON_CHAT = /^(embed|rerank)|(^|\/)(embed|rerank)/i;

const psql = (q) =>
  execSync(`docker exec postgre psql -U postgres -d fudrouter -tAc ${JSON.stringify(q)}`, {
    stdio: 'pipe',
  })
    .toString()
    .trim();

/**
 * SQL string literal. Do NOT use JSON.stringify for this: it emits double quotes,
 * which the outer shell strips before psql sees them, so `slug = "x:free"` becomes
 * `slug = x:free` and postgres reads it as schema `x` / relation `free`.
 */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

const mdlId = (slug) => 'mdl_' + createHash('sha256').update(`${PROVIDER_ID}:${slug}`).digest('hex').slice(0, 32);
const pmId = (slug) => 'pmdl_' + createHash('sha256').update(`${PROVIDER_ID}:pm:${slug}`).digest('hex').slice(0, 32);

/** crowllm's own key, needed only to enumerate the upstream catalogue. */
const KEY = execSync(
  'head -1 /home/dwizzy/.hermes/cache/scratch/crowllm_keys.txt'
).toString().trim();

const upstream = await fetch('https://crowllm.com/v1/models', {
  headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': UA, Accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
})
  .then((r) => r.json())
  .then((j) => j.data.map((m) => m.id));

const upstreamChat = upstream.filter((s) => s.endsWith(':free') && !NON_CHAT.test(s));

/** slugs currently wired to crowllm, with the shared row's global status */
const rows = psql(
  `select m.slug || '|' || pm.enabled || '|' || m.status from provider_model pm ` +
    `join model m on m.id = pm.model_id where pm.provider_id = '${PROVIDER_ID}'`
)
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('|'));

// NB: `pm.enabled || '|' || ...` string-concatenates the boolean to 'true'/'false'
// (a bare boolean column prints as 't'/'f' under -tA, but concatenation does not),
// so accept both spellings — getting this wrong silently reports "nothing to revive".
const truthy = (v) => v === 't' || v === 'true';
const registered = new Map(rows.map(([s, en, st]) => [s, { enabled: truthy(en), status: st }]));

const toAdd = upstreamChat.filter((s) => !registered.has(s));
const toRevive = rows.filter(([, en, st]) => truthy(en) && st !== 'active').map(([s]) => s);

console.log(`upstream :free chat models : ${upstreamChat.length}`);
console.log(`registered for ${PROVIDER_ID}  : ${rows.length}`);
console.log(`\n[A] unregistered (insert model + provider_model): ${toAdd.length}`);
for (const s of toAdd) console.log(`      + ${s}`);
console.log(`\n[B] enabled link on an inactive shared row (revive): ${toRevive.length}`);
for (const s of toRevive) {
  const owner = psql(`select provider_id from model where slug = ${lit(s)} limit 1`);
  console.log(`      ~ ${s}  (row owned by ${owner})`);
}

if (!APPLY) {
  console.log('\ndry run. pass --apply to write.');
  process.exit(0);
}

let added = 0;
for (const slug of toAdd) {
  const mid = mdlId(slug);
  const dev = psql(`select 1`); // keep psql warm; no-op
  psql(
    `insert into model (id, provider_id, name, slug, status, developer, description, capabilities, input_price, output_price) ` +
      `values (${lit(mid)}, '${PROVIDER_ID}', ${lit(slug)}, ${lit(slug)}, 'active', null, ` +
      `${lit('crowllm free tier: ' + slug)}, ${lit(
        JSON.stringify({ streaming: true, tools: true, vision: /vl|vision|omni|4v/i.test(slug) })
      )}::jsonb, 0, 0) on conflict (slug) do update set status='active', updated_at=now()`
  );
  psql(
    `insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status) ` +
      `values (${lit(pmId(slug))}, ${lit(mid)}, '${PROVIDER_ID}', '${CONNECTION_ID}', ` +
      `${lit(slug)}, true, 'available') on conflict (id) do update set enabled=true, status='available', updated_at=now()`
  );
  added++;
  void dev;
}

let revived = 0;
for (const slug of toRevive) {
  psql(`update model set status='active', updated_at=now() where slug = ${lit(slug)} and status <> 'active'`);
  revived++;
}

const served = psql(
  `select count(*) from provider_model pm join model m on m.id=pm.model_id ` +
    `where pm.provider_id='${PROVIDER_ID}' and pm.enabled and m.status='active'`
);
console.log(`\ninserted ${added} models, revived ${revived} shared rows`);
console.log(`now serveable for ${PROVIDER_ID}: ${served}`);
