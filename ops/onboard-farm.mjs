#!/usr/bin/env node
// ops/onboard-farm.mjs — generic farm-key onboarding into fudrouter.
//
// Replaces the deleted apps/web/scripts/merge-*-keys.mjs family. Every merge
// timer (freeai, gonka24, tt, mingles) has been failing with `.env: not found`
// since the apps/web refactor, so nothing landed for days: FreeAI and
// Top-Tools-AI sat at ZERO credentials while their farms held 2014 and 649 live
// keys. This one script covers every farm; adding a provider is a registry entry.
//
// Usage:  set -a && . .env && set +a && node ops/onboard-farm.mjs <farm> [--dry-run]
//         node ops/onboard-farm.mjs --list
// Knobs:  FARM_KEY_FILE, FARM_PROBE_CONCURRENCY, FARM_PROVIDER_STATUS
//
// Idempotent: credential id is cred_<farm>_<sha256(key)[:16]>, written once; a
// key that is dead at probe time is flipped to 'invalid' so the pool stops
// retrying it. provider.status is operator-owned and never clobbered.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Registry. base_url / connection ids mirror what is already in the DB, so the
// upsert refreshes an existing row instead of creating a twin.
// ---------------------------------------------------------------------------
const REGISTRY = {
  freeai: {
    providerId: 'prv_freeai',
    connectionId: 'con_prv_freeai-default',
    base: 'https://api.free.ai/v1',
    headers: {},
    keys: {
      kind: 'jsonl',
      file: '/home/dwizzy/freeai-farm/out/freeai_accounts.jsonl',
      field: 'api_key',
      emailField: 'email'
    }
  },
  tt: {
    providerId: 'prv_tt',
    connectionId: 'con_prv_tt-default',
    base: 'https://top-tools-ai.com/api/v1',
    headers: {},
    keys: {
      kind: 'lines',
      file: '/home/dwizzy/projects/tt_farm/out/credentials.txt',
      rx: /(sk-[A-Za-z0-9_-]{8,})/,
      email: /([^\s|]+@[^\s|]+)/
    }
  },
  excelnt: {
    providerId: 'prv_excelnt',
    connectionId: 'con_prv_excelnt-default',
    base: 'https://excelnt.ai/v1',
    headers: { 'x-excelnt-client': 'vscode' },
    keys: {
      kind: 'lines',
      file: '/home/dwizzy/farm_x/excelnt/hasil_apikey.txt',
      rx: /key:\s*(sk_live_\S+)/,
      email: /(\S+@\S+)/
    }
  },
  gonka24: {
    providerId: 'prv_gonka24',
    connectionId: 'con_prv_gonka24-default',
    base: 'https://api.gonka24.com/v1',
    headers: {},
    keys: {
      kind: 'jsonl',
      file: '/home/dwizzy/gonka24-automator/gonka24_keys.json',
      field: 'api_key',
      emailField: 'email'
    }
  },
  cline: {
    providerId: 'prv_cline',
    connectionId: 'con_prv_cline-default',
    base: 'https://api.cline.bot/api/v1',
    headers: {},
    keys: {
      kind: 'lines',
      file: '/home/dwizzy/cline-farm/cline_keys.txt',
      rx: /(sk_[A-Za-z0-9_-]{8,})/
    }
  },
  tokenharbor: {
    providerId: 'prv_tokenharbor',
    connectionId: 'con_prv_tokenharbor-default',
    base: 'http://43.128.99.142/thr/v1',
    headers: {},
    keys: {
      kind: 'lines',
      file: '/home/dwizzy/th-bot/th_keys_live.txt',
      rx: /(thk_\S+)/
    }
  }
};

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
if (argv.includes('--list') || argv.length === 0 || !REGISTRY[argv[0]]) {
  console.log('farms: ' + Object.keys(REGISTRY).join(', '));
  console.log('usage: node ops/onboard-farm.mjs <farm> [--dry-run]');
  process.exit(argv.length === 0 || argv.includes('--list') ? 0 : 1);
}
const NAME = argv[0];
const CFG = REGISTRY[NAME];
if (process.env.FARM_KEY_FILE) CFG.keys.file = process.env.FARM_KEY_FILE;
const PROBE_CONC = Number(process.env.FARM_PROBE_CONCURRENCY ?? 12);

const masterKey = () => {
  const k = process.env.CREDENTIALS_MASTER_KEY;
  if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
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

const credId = (key) => `cred_${NAME}_` + createHash('sha256').update(key).digest('hex').slice(0, 16);
const idOf = (k) => credId(k.key);

function loadKeys() {
  let text;
  try {
    text = readFileSync(CFG.keys.file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${CFG.keys.file}: ${e.message}`);
  }
  const out = [];
  const seen = new Set();
  const push = (key, email) => {
    const k = String(key ?? '').trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, email: String(email ?? '').trim() });
  };

  if (CFG.keys.kind === 'jsonl') {
    // Two shapes in the wild: real JSONL (free.ai appends one object per line)
    // and a pretty-printed JSON array (gonka24_keys.json is one document).
    let rows = null;
    try {
      const whole = JSON.parse(text);
      if (Array.isArray(whole)) rows = whole;
    } catch {
      /* not a single document — fall through to line parsing */
    }
    if (rows === null) {
      rows = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          rows.push(JSON.parse(t));
        } catch {
          /* skip malformed line */
        }
      }
    }
    for (const row of rows) push(row?.[CFG.keys.field], row?.[CFG.keys.emailField]);
  } else {
    for (const line of text.split('\n')) {
      const m = CFG.keys.rx.exec(line);
      if (!m) continue;
      const em = CFG.keys.email ? CFG.keys.email.exec(line) : null;
      push(m[1], em ? em[1] : '');
    }
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

async function probeKey(key) {
  try {
    const res = await fetch(`${CFG.base}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...CFG.headers },
      signal: AbortSignal.timeout(25_000)
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error('DATABASE_URL is required');
  const sql = postgres(dsn, { max: 1 });
  try {
    const all = loadKeys();
    if (all.length === 0) throw new Error(`no keys parsed from ${CFG.keys.file}`);
    console.log(`[${NAME}] keys in file: ${all.length}`);

    const live = await mapLimit(all, PROBE_CONC, async (k) => ((await probeKey(k.key)) ? k : null));
    const liveKeys = live.filter(Boolean);
    const deadKeys = all.filter((k) => !liveKeys.includes(k));
    console.log(`[${NAME}] live now: ${liveKeys.length}  dead now: ${deadKeys.length}`);
    if (liveKeys.length === 0) throw new Error('no live keys — upstream rejected every key');
    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    await sql.begin(async (tx) => {
      const legacyBlob = encryptJson({
        api_key: liveKeys[0].key,
        auth_kind: 'apikey',
        default_headers: CFG.headers,
        accounts: liveKeys.map((k) => ({
          email: k.email || `${NAME}-key`,
          access_token: k.key,
          refresh_token: null,
          expired: '2099-01-01T00:00:00Z'
        }))
      });
      const [prov] = await tx`
        update provider set credentials_enc = ${legacyBlob}, base_url = ${CFG.base}, updated_at = now()
        where id = ${CFG.providerId} returning id`;
      if (!prov) throw new Error(`provider ${CFG.providerId} does not exist — seed it first`);
      const [conn] = await tx`
        update connection set base_url = ${CFG.base}, enabled = true,
          config = ${tx.json({ auth_kind: 'apikey', default_headers: CFG.headers })}, updated_at = now()
        where id = ${CFG.connectionId} returning id`;
      if (!conn) throw new Error(`connection ${CFG.connectionId} does not exist`);

      let newCreds = 0;
      for (const k of liveKeys) {
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${credId(k.key)}, ${CFG.connectionId}, ${k.email || credId(k.key)},
                  ${encryptJson({ api_key: k.key, email: k.email })}, 'unknown',
                  ${tx.json(k.email ? { email: k.email } : {})})
          on conflict (id) do update set secret_enc = excluded.secret_enc, updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
      }
      let invalidated = 0;
      for (const k of deadKeys) {
        const r = await tx`
          update credential set status = 'invalid', updated_at = now()
          where id = ${idOf(k)} and status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      const pm = await tx`
        update provider_model set enabled = true, status = 'available', updated_at = now()
        where provider_id = ${CFG.providerId} returning id`;
      const md = await tx`
        update model set status = 'active', updated_at = now()
        where provider_id = ${CFG.providerId} and status <> 'active' returning id`;
      console.log(`[${NAME}] credentials: ${newCreds} new, ${liveKeys.length - newCreds} refreshed, ${invalidated} marked invalid`);
      console.log(`[${NAME}] provider_models enabled: ${pm.length}, models activated: ${md.length}`);
    });

    const [cc] = await sql`
      select count(*)::int n, count(*) filter (where cr.status = 'invalid')::int inv
      from credential cr join connection cn on cn.id = cr.connection_id
      where cn.provider_id = ${CFG.providerId}`;
    console.log(`[${NAME}] pool now: ${cc.n} credentials (invalid=${cc.inv})`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
