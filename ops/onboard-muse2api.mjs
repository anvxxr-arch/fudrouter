#!/usr/bin/env node
// ops/onboard-muse2api.mjs — onboard the local muse2api bridge into fudrouter.
//
// Why a script and not SQL: `provider.credentials_enc` and `credential.secret_enc`
// are AES-256-GCM ciphertext whose envelope only code holding
// CREDENTIALS_MASTER_KEY can produce — same base64(iv[12] || ct || tag[16]) wire
// format as packages/platform/server/credentials.ts and backend/go/internal/crypt.
//
// muse2api is a LOCAL OpenAI-compatible bridge in front of muse.ai (the browser
// drive lives in /home/dwizzy/muse2api, listening on 127.0.0.1:18610). It is a
// loopback upstream, which the data plane permits only because this deployment
// sets ALLOW_PRIVATE_UPSTREAMS=1 (precedent: prv_kiro -> http://127.0.0.1:8795/v1).
//
// Idempotent by construction:
//   * provider     — upsert on id; `status` is PRESERVED (operator owns it).
//   * connection   — upsert on id; egress_mode stays 'direct' (a loopback target
//                    must NOT be source-IP rotated — binding an IPv6 source to
//                    127.0.0.1 fails closed).
//   * credential   — deterministic id from sha256(secret); written once.
//   * model        — created when the slug is free, else reused untouched.
//
// Usage:  set -a && . .env && set +a && node ops/onboard-muse2api.mjs [--dry-run]
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const DRY = process.argv.includes('--dry-run');

const CFG = {
  providerId: 'prv_muse2api',
  connectionId: 'con_prv_muse2api-default',
  providerName: 'muse2api (local bridge)',
  slug: 'muse2api',
  base: process.env.MUSE2API_BASE ?? 'http://127.0.0.1:18610/v1',
  apiKey: process.env.MUSE2API_KEY ?? '',
  // Loopback upstream: must NOT bind a source IPv6. `direct` fails closed here
  // (dial tcp [2404:...]:0: no suitable address found) because the route binds a
  // local v6 source onto a 127.0.0.1 target. `ipv6_rotate` is the historical
  // default that returns a nil route -> the proxy keeps its injected client and
  // dials the loopback address plainly. This mirrors prv_kiro (also loopback).
  egress: 'ipv6_rotate',
  priority: 205,
  // Chat first (billed, chat-capable), then the media keys the media surface
  // routes on.
  //
  // `upstream` is the bridge's OWN model id and it is NOT cosmetic: the bridge's
  // resolve_model rejects a kind mismatch, so an image call must name
  // `muse-image` and a video call `muse-video` — pointing them at `muse-chat`
  // (as an earlier revision of this file did) makes every media request fail
  // upstream with "model is not an image model". `modality`/`caps` are what the
  // catalogue advertises; they no longer have to describe "text only" because
  // the media surface (internal/proxy/media.go) serves these natively instead of
  // leaving them to the generic passthrough hatch.
  models: [
    { slug: 'gpt-4o', upstream: 'muse-chat', name: 'Muse Chat (gpt-4o alias)', ctx: 128000 },
    { slug: 'gpt-5', upstream: 'muse-chat', name: 'Muse Chat (gpt-5 alias)', ctx: 128000 },
    { slug: 'claude-sonnet-4', upstream: 'muse-chat', name: 'Muse Chat (claude alias)', ctx: 200000 },
    { slug: 'deepseek-chat', upstream: 'muse-chat', name: 'Muse Chat (deepseek alias)', ctx: 128000 },
    {
      slug: 'muse-image', upstream: 'muse-image', name: 'Muse Image', ctx: null,
      modality: { type: 'image' }, caps: { chat: false },
      desc: 'Text-to-image and image editing through the local muse2api bridge'
    },
    {
      slug: 'muse-video', upstream: 'muse-video', name: 'Muse Video', ctx: null,
      modality: { type: 'video' }, caps: { chat: false },
      desc: 'Text-to-video and first-frame image-to-video through the local muse2api bridge'
    }
  ],
  headers: {}
};

function masterKey() {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
  return buf;
}

function encryptJson(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const idOf = (key) => 'cred_muse2api_' + createHash('sha256').update(key).digest('hex').slice(0, 16);

async function probe() {
  const res = await fetch(`${CFG.base}/models`, {
    headers: CFG.apiKey ? { Authorization: `Bearer ${CFG.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000)
  });
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}` };
  const body = await res.json();
  return { ok: true, ids: (body.data ?? []).map((m) => m.id) };
}

async function main() {
  if (!CFG.apiKey) throw new Error('MUSE2API_KEY is required (the bridge API key)');
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');

  const p = await probe();
  if (!p.ok) throw new Error(`muse2api bridge unreachable at ${CFG.base}: ${p.why}`);
  console.log(`[muse2api] bridge live at ${CFG.base}; upstream models: ${p.ids.join(', ')}`);

  const missing = CFG.models.filter((m) => !p.ids.includes(m.upstream));
  if (missing.length) throw new Error(`bridge does not expose: ${missing.map((m) => m.upstream).join(', ')}`);

  if (DRY) {
    console.log('--dry-run: no writes');
    return;
  }

  const sql = postgres(dsn, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      // provider: insert-only defaults; status/enabled are operator-owned so a
      // re-run never resurrects a provider the operator took down.
      await tx`
        insert into provider (id, name, slug, description, type, status, tier, enabled, priority, base_url, credentials_enc)
        values (${CFG.providerId}, ${CFG.providerName}, ${CFG.slug},
                ${'Local bridge in front of muse.ai (browser-driven, no card). Loopback upstream.'},
                ${'openai_compatible'}, 'active', 'commercial', true, ${CFG.priority}, ${CFG.base}, '')
        on conflict (id) do update set
          name = excluded.name, slug = excluded.slug, description = excluded.description,
          type = excluded.type, tier = excluded.tier, base_url = excluded.base_url,
          updated_at = now()`;

      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, timeout_ms, priority, enabled, config, egress_mode)
        values (${CFG.connectionId}, ${CFG.providerId}, ${'muse2api'}, 'default', ${CFG.base},
                'bearer', 300000, 100, true,
                ${tx.json({ auth_kind: 'apikey', default_headers: CFG.headers, protocol: 'http' })},
                ${CFG.egress})
        on conflict (id) do update set
          base_url = excluded.base_url, enabled = true, config = excluded.config,
          egress_mode = excluded.egress_mode, updated_at = now()`;

      const credId = idOf(CFG.apiKey);
      const r = await tx`
        insert into credential (id, connection_id, name, secret_enc, status, metadata)
        values (${credId}, ${CFG.connectionId}, ${'muse2api bridge key'},
                ${encryptJson({ api_key: CFG.apiKey })}, 'unknown', ${tx.json({ local_bridge: true })})
        on conflict (id) do update set
          secret_enc = excluded.secret_enc,
          status = case when credential.status = 'invalid' then 'unknown' else credential.status end,
          updated_at = now()
        returning (xmax = 0) as inserted`;
      console.log(`[muse2api] credential ${r[0].inserted ? 'created' : 'refreshed'}: ${credId}`);

      for (const m of CFG.models) {
        const modelId = 'mdl_muse2api_' + m.slug.replace(/[^a-z0-9]+/gi, '_');
        const ins = await tx`
          insert into model (id, provider_id, name, slug, family, developer, description, context, input_price, output_price, currency, status, modality, capabilities)
          values (${modelId}, ${CFG.providerId}, ${m.name}, ${m.slug}, ${'muse'}, ${'muse.ai'},
                  ${m.desc ?? null}, ${m.ctx}, 0, 0, 'USD', 'active',
                  ${tx.json(m.modality ?? { type: 'text' })}, ${tx.json(m.caps ?? { chat: true })})
          on conflict (slug) do update set
            status = 'active', modality = excluded.modality,
            capabilities = excluded.capabilities, updated_at = now()
          returning id`;
        const reused = ins.length === 0;
        const effectiveId = reused
          ? (await tx`select id from model where slug = ${m.slug} limit 1`)[0].id
          : ins[0].id;
        const pmId = 'pm_muse2api_' + m.slug.replace(/[^a-z0-9]+/gi, '_');
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${pmId}, ${effectiveId}, ${CFG.providerId}, ${CFG.connectionId}, ${m.upstream}, true, 'available')
          on conflict (id) do update set
            model_id = excluded.model_id, provider_model_id = excluded.provider_model_id,
            connection_id = excluded.connection_id, enabled = true, status = 'available',
            updated_at = now()`;
        console.log(`[muse2api] model ${m.slug} -> ${m.upstream} (${reused ? 'REUSED canonical row' : 'created'})`);
      }
    });

    const [cc] = await sql`
      select count(*)::int n from credential cr
      join connection cn on cn.id = cr.connection_id where cn.provider_id = ${CFG.providerId}`;
    console.log(`[muse2api] pool: ${cc.n} credential(s)`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
