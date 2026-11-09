#!/usr/bin/env node
// ops/zcode-bridge/import.mjs — onboard ZCode start-plan (GLM) accounts
// produced by zcode-bridge (bridge.py) into fudrouter.
//
// Each account = one zcodeJwtToken (+ optional userId/businessAccessToken).
// These are start-plan Anthropic-format credentials for
// https://zcode.z.ai/api/v1/zcode-plan/anthropic (Claude surface).
//
// Mirrors ops/onboard-zai.mjs: direct postgres inserts (DATABASE_URL), AES-256-GCM
// encrypt via CREDENTIALS_MASTER_KEY, provider + connection + credential + model
// + provider_model seed, all in one transaction.
//
// Usage:
//   set -a && . .env && set +a
//   node ops/zcode-bridge/import.mjs [--dry-run]            # reads accounts.jsonl next to this file
//   node ops/zcode-bridge/import.mjs --accounts other.jsonl
//   ZAI_REFRESH=1 ...    # refresh each JWT via /api/auth/z/login before storing
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const ACC = process.argv[process.argv.indexOf('--accounts') + 1] || process.env.ZCODE_ACCOUNTS_FILE
  || join(HERE, 'accounts.jsonl');
const REFRESH = process.env.ZAI_REFRESH === '1';

const PROVIDER_ID = 'prv_zai_zcode';
const CONNECTION_ID = 'con_prv_zai_zcode-default';
const PROVIDER_NAME = 'Z.AI ZCode Start Plan (GLM)';
const BASE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic';
const PRIORITY = Number(process.env.ZAI_ZCODE_PRIORITY ?? 160);

// Start-plan models (zcodePlan.js). Slug is the upstream model id.
const MODELS = [
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash', context: 200000, max_output: 16384, in: 0, out: 0, family: 'glm', developer: 'zhipu', desc: 'GLM-5.3 Flash via ZCode Start Plan (GLM)' },
  { id: 'GLM-5.2', name: 'GLM-5.2', context: 200000, max_output: 16384, in: 0, out: 0, family: 'glm', developer: 'zhipu', desc: 'GLM-5.2 via ZCode Start Plan (GLM)' },
  { id: 'GLM-5-Turbo', name: 'GLM-5 Turbo', context: 200000, max_output: 16384, in: 0, out: 0, family: 'glm', developer: 'zhipu', desc: 'GLM-5 Turbo via ZCode Start Plan (GLM)' },
];

const masterKey = () => {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
  return buf;
};
const encryptJson = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};

const rows = [];
if (existsSync(ACC)) {
  for (const line of readFileSync(ACC, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
}
if (rows.length === 0) { console.error(`no accounts in ${ACC}`); process.exit(1); }

async function refreshJwt(row) {
  const psd = row.providerSpecificData || {};
  const biz = psd.businessAccessToken || psd.accessToken || row.businessAccessToken;
  if (!biz) return psd.zcodeJwtToken || row.zcodeJwtToken;
  const r = await fetch('https://api.z.ai/api/auth/z/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: biz }),
  });
  const d = await r.json();
  const tok = d?.data?.token || d?.data?.access_token || d?.token || d?.access_token;
  return tok || psd.zcodeJwtToken || row.zcodeJwtToken;
}

const credId = (row) => {
  const jwt = row.providerSpecificData?.zcodeJwtToken || row.zcodeJwtToken || row.id || '';
  return 'cred_zcode_' + createHash('sha256').update(jwt).digest('hex').slice(0, 16);
};

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });

  try {
    const creds = [];
    for (const row of rows) {
      const psd = row.providerSpecificData || {};
      let jwt = psd.zcodeJwtToken || row.zcodeJwtToken;
      if (REFRESH) jwt = await refreshJwt(row);
      if (!jwt) { console.error(`skip ${row.id || row.flow_id}: no zcodeJwtToken`); continue; }
      creds.push({
        id: credId(row),
        jwt,
        userId: psd.userId || row.userId || '',
        biz: psd.businessAccessToken || row.businessAccessToken || '',
        linkedAt: row.linkedAt,
      });
    }
    if (creds.length === 0) throw new Error('no usable accounts');
    console.log(`accounts: ${creds.length} (${rows.length} rows)`);

    // slug owner-guard (model.slug is UNIQUE table-wide)
    const owned = new Map();
    for (const m of MODELS) {
      const [row] = await sql`select provider_id from model where slug = ${m.id}`;
      if (row) owned.set(m.id, row.provider_id);
    }
    const seedable = MODELS.filter((m) => !owned.has(m.id));
    for (const m of MODELS.filter((m) => owned.has(m.id))) console.log(`  skip slug ${m.id}: owned by ${owned.get(m.id)}`);
    if (seedable.length === 0) throw new Error('every start-plan slug is owned by another provider');

    if (DRY) {
      console.log('--dry-run: no writes');
      console.log(`would seed: ${seedable.map((m) => m.id).join(', ')}`);
      console.log(`would onboard credentials: ${creds.length}`);
      return;
    }

    await sql.begin(async (tx) => {
      // legacy credentials blob on provider row (router may read it)
      const legacyBlob = encryptJson({
        auth_kind: 'zcode_plan_jwt',
        default_headers: { 'x-api-key': creds[0].jwt, 'anthropic-version': '2023-06-01' },
        accounts: creds.map((c) => ({ userId: c.userId, zcodeJwtToken: c.jwt, businessAccessToken: c.biz })),
      });

      await tx`
        insert into provider (id, name, base_url, credentials_enc, status, priority)
        values (${PROVIDER_ID}, ${PROVIDER_NAME}, ${BASE_URL}, ${legacyBlob}, 'active', ${PRIORITY})
        on conflict (id) do update set
          base_url = excluded.base_url,
          credentials_enc = excluded.credentials_enc,
          priority = excluded.priority,
          updated_at = now()`;

      await tx`
        insert into connection (id, provider_id, name, slug, base_url, auth_type, priority, enabled, config)
        values (${CONNECTION_ID}, ${PROVIDER_ID}, 'zcode-plan', 'default', ${BASE_URL}, 'x-api-key', ${PRIORITY}, true,
                ${tx.json({ auth_kind: 'zcode_plan_jwt', default_headers: { 'anthropic-version': '2023-06-01' } })})
        on conflict (id) do update set base_url = excluded.base_url, enabled = true, updated_at = now()`;

      let newCreds = 0;
      for (const c of creds) {
        const secret = encryptJson({ api_key: c.jwt, zcodeJwtToken: c.jwt, userId: c.userId, businessAccessToken: c.biz });
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${c.id}, ${CONNECTION_ID}, ${c.id}, ${secret}, 'healthy',
                  ${tx.json({ auth_kind: 'zcode_plan_jwt', userId: c.userId, source: 'zcode-bridge', linkedAt: c.linkedAt ?? null })})
          on conflict (id) do update set secret_enc = excluded.secret_enc, status = 'healthy', updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
      }
      console.log(`credentials: ${newCreds} new, ${creds.length - newCreds} refreshed`);

      let seeded = 0;
      for (const m of seedable) {
        const modelId = randomUUID();
        await tx`
          insert into model (id, provider_id, name, slug, context, max_output, input_price, output_price,
                             family, developer, description, status)
          values (${modelId}, ${PROVIDER_ID}, ${m.name}, ${m.id}, ${m.context}, ${m.max_output},
                  ${m.in}, ${m.out}, ${m.family}, ${m.developer}, ${m.desc}, 'active')
          on conflict (slug) do update set
            name = excluded.name, context = excluded.context, max_output = excluded.max_output,
            input_price = excluded.input_price, output_price = excluded.output_price, updated_at = now()`;
        await tx`
          insert into provider_model (id, model_id, provider_id, connection_id, provider_model_id, enabled, status)
          values (${'pmdl_' + modelId}, ${modelId}, ${PROVIDER_ID}, ${CONNECTION_ID}, ${m.id}, true, 'available')
          on conflict (id) do update set enabled = true, status = 'available', updated_at = now()`;
        seeded += 1;
        console.log(`  seeded ${m.id}`);
      }
      console.log(`models seeded: ${seeded}`);
    });

    const [cc] = await sql`select count(*)::int n from credential cr join connection cn on cn.id = cr.connection_id where cn.provider_id = ${PROVIDER_ID}`;
    console.log(`pool now: ${cc.n} credentials`);
    console.log('verify (openai surface): curl http://127.0.0.1:8100/v1/chat/completions -H "Authorization: Bearer <any key>" -d \'{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}],"max_tokens":5}\'');
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
