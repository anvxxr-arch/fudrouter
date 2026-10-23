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
// The farm herd was consolidated under one root on 2026-10-10. Three entries here
// still pointed at the old ~/<name> paths, so the merge jobs died with ENOENT while
// the farms kept producing (free.ai alone had 4,260 rows waiting). Keep the root in
// ONE place so the next move is one edit -- a hardcoded absolute path with no shared
// root is exactly how this rots silently. FARM_KEY_FILE still overrides per run.
const FARM_DIR = process.env.FARM_PROVIDERS_DIR ?? '/home/dwizzy/farm/providers';

const REGISTRY = {
  freeai: {
    providerId: 'prv_freeai',
    connectionId: 'con_prv_freeai-default',
    base: 'https://api.free.ai/v1',
    headers: {},
    keys: {
      kind: 'jsonl',
      file: `${FARM_DIR}/freeai-farm/out/freeai_accounts.jsonl`,
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
      file: `${FARM_DIR}/cline-farm/cline_keys.txt`,
      rx: /(sk_[A-Za-z0-9_-]{8,})/
    }
  },
  minimax: {
    providerId: 'prv_minimax',
    connectionId: 'con_prv_minimax-default',
    base: 'https://api.minimax.io/v1',
    headers: {},
    keys: {
      kind: 'lines',
      file: '/home/dwizzy/.secrets/minimax.keys.txt',
      rx: /(sk-cp-[A-Za-z0-9_-]{8,})/
    }
  },
  tokenharbor: {
    providerId: 'prv_tokenharbor',
    connectionId: 'con_prv_tokenharbor-default',
    // The relay IP (43.128.99.142/thr/v1) is DEAD: it answers
    // 403 wrong_host — "This address does not serve the API. Use
    // https://tokenharbor.ai/v1 as the base URL." Probing through it rejected
    // every key, so th_sync exited 1 on "no live keys" forever, and the data
    // plane marked 4431 credentials invalid in one hour (2026-10-16 13:00) for
    // what was a configuration error, not a credential one. Keep this in step
    // with connection.base_url — whichever one rots first poisons the pool.
    base: 'https://tokenharbor.ai/v1',
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

// A non-200 does NOT mean "dead key". 401/403 is the upstream refusing THIS key;
// a transport error, a 429 or a 5xx means the base URL or the upstream itself is
// broken. Conflating the two is what let the dead relay IP (403 wrong_host on
// every request) poison 4431 credentials, and it is also what makes the caller
// exit 1 for ever on a backlog of keys that really are dead.
const LIVE = 'live';
const REJECTED = 'rejected';
const UNREACHABLE = 'unreachable';

async function probeKey(key) {
  try {
    const res = await fetch(`${CFG.base}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...CFG.headers },
      signal: AbortSignal.timeout(25_000)
    });
    return res.status === 200 ? LIVE : res.status === 401 || res.status === 403 ? REJECTED : UNREACHABLE;
  } catch {
    return UNREACHABLE;
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

    const verdicts = await mapLimit(all, PROBE_CONC, (k) => probeKey(k.key));
    const liveKeys = all.filter((_, i) => verdicts[i] === LIVE);
    const rejected = all.filter((_, i) => verdicts[i] === REJECTED);
    const unreachable = all.filter((_, i) => verdicts[i] === UNREACHABLE);
    console.log(`[${NAME}] live now: ${liveKeys.length}  rejected: ${rejected.length}  unreachable: ${unreachable.length}`);
    // Failing to reach the upstream with EVERY key is a configuration or outage
    // alarm — the dead relay answered 403 wrong_host to all 5754 keys and the
    // caller read that as "every credential is dead". Only that case is fatal;
    // a backlog of genuinely rejected keys is work, not an error (see the
    // tombstone write below), which is what kept the sync red for 26 ticks.
    if (liveKeys.length === 0 && unreachable.length === all.length) {
      throw new Error(`no live keys — ${CFG.base} unreachable for all ${all.length} keys (base URL or upstream outage)`);
    }
    if (DRY) {
      console.log('--dry-run: no writes');
      return;
    }

    await sql.begin(async (tx) => {
      // base_url drift is configuration, not credential state, so it is repaired
      // even on a run that found nothing live — otherwise a rotted base outlives
      // the fix and the next probe rejects every key again.
      const [prov] = await tx`
        update provider set base_url = ${CFG.base}, updated_at = now()
        where id = ${CFG.providerId} returning id`;
      if (!prov) throw new Error(`provider ${CFG.providerId} does not exist — seed it first`);
      if (liveKeys.length > 0) {
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
        await tx`update provider set credentials_enc = ${legacyBlob}, updated_at = now() where id = ${CFG.providerId}`;
      }
      const [conn] = await tx`
        update connection set base_url = ${CFG.base}, enabled = true,
          config = ${tx.json({ auth_kind: 'apikey', default_headers: CFG.headers })}, updated_at = now()
        where id = ${CFG.connectionId} returning id`;
      if (!conn) throw new Error(`connection ${CFG.connectionId} does not exist`);

      // A key that probes live is not invalid: the upsert restores it. Without the
      // status case 'invalid' is a one-way door — the 4431 rows the relay
      // misconfiguration poisoned could never come back, and the pool would only
      // ever shrink.
      let newCreds = 0;
      for (const k of liveKeys) {
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${credId(k.key)}, ${CFG.connectionId}, ${k.email || credId(k.key)},
                  ${encryptJson({ api_key: k.key, email: k.email })}, 'unknown',
                  ${tx.json(k.email ? { email: k.email } : {})})
          on conflict (id) do update set
            secret_enc = excluded.secret_enc,
            status = case when credential.status = 'invalid' then 'unknown' else credential.status end,
            updated_at = now()
          returning (xmax = 0) as inserted`;
        if (r.length > 0 && r[0].inserted) newCreds += 1;
      }
      // A rejected key with NO row has nowhere to live: `update ... where id=...`
      // matches nothing, so it stays pending for ever, the caller re-probes the same
      // dead set every tick, and the sync exits 1 with zero new information — the
      // loop that ran 26 ticks before the relay fix and would resume on the next
      // batch of dead keys. This insert is what implements the "flipped to
      // 'invalid' so the pool stops retrying it" this file has always documented.
      // Unreachable keys are deliberately NOT recorded: an outage is not a verdict.
      let invalidated = 0;
      for (const k of rejected) {
        const r = await tx`
          insert into credential (id, connection_id, name, secret_enc, status, metadata)
          values (${idOf(k)}, ${CFG.connectionId}, ${k.email || idOf(k)},
                  ${encryptJson({ api_key: k.key, email: k.email })}, 'invalid',
                  ${tx.json(k.email ? { email: k.email } : {})})
          on conflict (id) do update set status = 'invalid', updated_at = now()
          where credential.status <> 'invalid' returning id`;
        if (r.length > 0) invalidated += 1;
      }
      // Publishing needs something live behind it: with every key rejected, marking
      // models available would advertise a provider that cannot serve.
      let pm = [], md = [];
      if (liveKeys.length > 0) {
        pm = await tx`
          update provider_model set enabled = true, status = 'available', updated_at = now()
          where provider_id = ${CFG.providerId} returning id`;
        md = await tx`
          update model set status = 'active', updated_at = now()
          where provider_id = ${CFG.providerId} and status <> 'active' returning id`;
      }
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
