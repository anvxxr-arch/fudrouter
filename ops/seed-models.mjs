#!/usr/bin/env node
// ops/seed-models.mjs — register a provider's upstream catalogue as routable
// models. Use when a provider has a live credential pool but 0 provider_model
// rows: the router resolves an incoming `model` slug through
// provider_model -> model, so a pool with no mappings can never serve a request
// no matter how many healthy keys it holds. Measured on prv_mistral: 77 healthy
// credentials, 0 mappings — every "mistral" route test silently landed on
// freeai's slug of the same name.
//
// Usage:
//   set -a && . /home/dwizzy/fudrouter/.env && set +a
//   node ops/seed-models.mjs <provider_id> [--slug-prefix mistral] [--filter substr] [--apply] [--limit N]
//
// Dry run by default. Idempotent: upserts by deterministic id, so re-running
// refreshes context/status instead of duplicating rows.
// After --apply: go run ./cmd/poolrebuild <provider_id> is NOT needed for models,
// but `pm2 restart fudrouter-router` is (model map is read at boot).
import { createDecipheriv } from 'node:crypto';
import postgres from 'postgres';

const argv = process.argv.slice(2);
const provider = argv.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const LIMIT = Number(flag('limit', 0)) || 0;
const FILTER = flag('filter', '') || '';
if (!provider) { console.error('usage: seed-models.mjs <provider_id> [--slug-prefix X] [--filter substr] [--limit N] [--apply]'); process.exit(2); }

const master = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
function decrypt(enc) {
  const raw = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
}

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const [conn] = await sql`
  select cn.id, cn.base_url, p.id as pid from connection cn join provider p on p.id=cn.provider_id
   where cn.provider_id=${provider} limit 1`;
if (!conn) throw new Error(`no connection for ${provider}`);
const base = String(conn.base_url).replace(/\/+$/, '');
const PREFIX = (flag('slug-prefix', '') || provider.replace(/^prv_/, '')).replace(/\/+$/, '');

const [cred] = await sql`
  select cr.secret_enc from credential cr join connection cn on cn.id=cr.connection_id
   where cn.provider_id=${provider} and cr.status='healthy' and cr.secret_enc is not null limit 1`;
if (!cred) throw new Error(`no healthy credential for ${provider} — run ops/cred-probe-promote.mjs first`);
const apiKey = (() => { const s = decrypt(cred.secret_enc); return s.api_key || s.access_token; })();

const resp = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
if (!resp.ok) throw new Error(`GET ${base}/models -> ${resp.status}`);
const catalogue = (await resp.json()).data || [];
console.log(`[seed] ${provider} upstream catalogue: ${catalogue.length} ids (prefix=${PREFIX})`);
let wanted = catalogue.map((m) => ({ id: m.id, ctx: m.max_context_tokens || m.context_length || 32768, name: m.name || m.id }));
if (FILTER) wanted = wanted.filter((m) => m.id.toLowerCase().includes(FILTER.toLowerCase()));
if (LIMIT) wanted = wanted.slice(0, LIMIT);
console.log(`[seed] selected ${wanted.length}: ${wanted.map((w) => w.id).slice(0, 12).join(', ')}${wanted.length > 12 ? ' …' : ''}`);

const slugFor = (up) => `${PREFIX}/${up}`;
const midFor = (up) => `mdl_${PREFIX.replace(/[^a-z0-9]+/gi, '_')}_${up.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 120);

// A non-chat id advertised as `chat:true` is a live 502/503 generator: the
// candidate query picks it for a chat request, the upstream answers 400/404, and
// the caller sees an upstream failure. Measured on prv_mistral: 23 rows
// (mistral-embed, codestral-embed, voxtral-*, moderations) carried `chat:true`
// and produced the 502/CIRCUIT_OPEN class. Classify here so a re-seed can never
// re-introduce the mislabel, and let the conflict branch repair an old row.
const NON_CHAT = /(embed|rerank|moderat|guard|whisper|transcri|voxtral|audio|speech|tts|fim|ocr|image-gen|dall|sdxl|stable-diffusion|flux|deoldify|demucs|csm-|dia-)/i;
const capsFor = (up) => (NON_CHAT.test(up) ? { chat: false } : { chat: true });
const isChat = (up) => capsFor(up).chat;

if (!APPLY) {
  const nonChat = wanted.filter((w) => !isChat(w.id)).length;
  console.log(`[seed] dry run — would insert ${wanted.length} models (${nonChat} non-chat, marked chat:false):`);
  for (const w of wanted.slice(0, 8)) console.log(`   model ${midFor(w.id)} slug=${slugFor(w.id)} ctx=${w.ctx} chat=${isChat(w.id)}`);
  console.log('[seed] re-run with --apply to persist.');
} else {
  let models = 0, maps = 0;
  for (const w of wanted) {
    const mid = midFor(w.id);
    const slug = slugFor(w.id);
    const ins = await sql`
      insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, modality, capabilities)
      values (${mid}, ${provider}, ${w.name}, ${slug}, ${w.ctx}, 0, 0, 'USD', 'active', '{"type":"text"}', ${sql.json(capsFor(w.id))})
      on conflict (id) do update set slug=excluded.slug, context=excluded.context, status='active',
        capabilities=excluded.capabilities, updated_at=now()
      returning id`;
    models += ins.length;

    const pmid = `pmdl_${mid}`;
    const up = await sql`
      insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, capabilities_override, status)
      values (${pmid}, ${mid}, ${provider}, ${conn.id}, ${w.id}, true, '{}', 'available')
      on conflict (id) do update set provider_model_id=excluded.provider_model_id, enabled=true, status='available', updated_at=now()
      returning id`;
    maps += up.length;
  }
  console.log(`[seed] upserted models=${models} mappings=${maps}`);
  const check = await sql`select count(*)::int n from provider_model where provider_id=${provider} and status='available' and enabled`;
  console.log(`[seed] provider_model available+enabled now: ${check[0].n}`);
  console.log('[seed] next: pm2 restart fudrouter-router');
}
await sql.end();
