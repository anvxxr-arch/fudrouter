#!/usr/bin/env node
// ops/opencode-farm.mjs — mint OpenCode Zen accounts via OAuth device flow.
//
// OpenCode Zen free tier is gated per-account (~100 req/day): capacity is a
// function of how many accounts you hold. Each account is minted by the OAuth
// device flow the CLI uses internally (extracted from the opencode binary):
//
//   POST console.opencode.ai/auth/device/code     { client_id: "opencode-cli" }
//     -> { device_code, user_code, verification_uri_complete, expires_in, interval }
//   [human/browser authorizes at verification_uri_complete]
//   POST console.opencode.ai/auth/device/token
//     { grant_type: "urn:ietf:params:oauth:grant-type:device_code",
//       device_code, client_id }
//     -> { access_token, refresh_token, expires_in, ... }
//
// Mode A (single, interactive): prints the auth URL + user_code, waits for the
//   operator to approve in a browser, then polls and persists the tokens.
// Mode B (batch): mints N device codes in parallel and writes them to
//   --pending so a browser driver (camoufox) can approve them one by one; a
//   second run with --harvest polls each pending code and persists the winners.
//
// Usage:
//   node ops/opencode-farm.mjs --interactive         # one account, ask browser
//   node ops/opencode-farm.mjs --batch 10 --pending /tmp/oc_pending.jsonl
//   node ops/opencode-farm.mjs --harvest /tmp/oc_pending.jsonl
//
// Knobs: OPENCODE_CONSOLE (default https://console.opencode.ai),
//        OPENCODE_OUT (default .../opencode_accounts.jsonl),
//        OPENCODE_CLIENT_ID (default opencode-cli).

const CONSOLE = (process.env.OPENCODE_CONSOLE || 'https://console.opencode.ai').replace(/\/$/, '');
const CLIENT_ID = process.env.OPENCODE_CLIENT_ID || 'opencode-cli';
const OUT = process.env.OPENCODE_OUT ||
  '/home/dwizzy/farm/providers/opencode-farm/out/opencode_accounts.jsonl';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_GRANT = 'refresh_token';

const argv = process.argv.slice(2);
const flag = (n) => argv.indexOf('--' + n);
const val = (n) => (flag(n) >= 0 ? argv[flag(n) + 1] : undefined);

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(CONSOLE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

async function deviceCode() {
  const r = await post('/auth/device/code', { client_id: CLIENT_ID });
  if (r.status !== 200) throw new Error(`device/code ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

function persist(account) {
  mkdirSync(dirname(OUT), { recursive: true });
  appendFileSync(OUT, JSON.stringify(account) + '\n');
}

async function pollToken(deviceCode, { quiet = false } = {}) {
  const deadline = Date.now() + (deviceCode.expires_in ?? 600) * 1000;
  const interval = (deviceCode.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await post('/auth/device/token', {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode.device_code,
      client_id: CLIENT_ID
    });
    if (r.status === 200) return r.json;
    // authorization_pending / slow_down -> keep polling; expired/denied -> fail.
    if (r.json?.error === 'access_denied' || r.json?.error === 'expired_token') {
      if (!quiet) console.error(`  device ${deviceCode.user_code}: ${r.json.error}`);
      return null;
    }
    if (r.json?.error === 'slow_down') await sleep(interval);
  }
  if (!quiet) console.error(`  device ${deviceCode.user_code}: timed out`);
  return null;
}

async function interactive() {
  const dc = await deviceCode();
  const url = dc.verification_uri_complete || CONSOLE + dc.verification_uri;
  console.log('\n=== OpenCode Zen device flow ===');
  console.log(`1. Open:   ${url}`);
  console.log(`2. Code:   ${dc.user_code}`);
  console.log('3. Sign in + approve, then wait (I am polling)...\n');
  const tok = await pollToken(dc);
  if (!tok) { console.error('authorization not completed'); process.exit(1); }
  const account = {
    email: tok.email || tok.account_id || '',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    id_token: tok.id_token || '',
    expires_in: tok.expires_in,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 21600) * 1000).toISOString(),
    minted_at: new Date().toISOString()
  };
  persist(account);
  console.log(`\nminted account${account.email ? ' ' + account.email : ''} -> ${OUT}`);
}

async function batch(n, pendingFile) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const dc = await deviceCode();
    codes.push({ ...dc, created_at: new Date().toISOString() });
    console.log(`[${i + 1}/${n}] ${dc.user_code}  ${dc.verification_uri_complete || CONSOLE + dc.verification_uri}`);
  }
  mkdirSync(dirname(pendingFile), { recursive: true });
  writeFileSync(pendingFile, codes.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`\n${n} device codes -> ${pendingFile}. Approve each in a browser, then run --harvest.`);
}

async function harvest(pendingFile) {
  const codes = readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`harvesting ${codes.length} pending device codes...`);
  let won = 0;
  for (const dc of codes) {
    const tok = await pollToken(dc);
    if (!tok) continue;
    persist({
      email: tok.email || tok.account_id || '',
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      id_token: tok.id_token || '',
      expires_in: tok.expires_in,
      expires_at: new Date(Date.now() + (tok.expires_in ?? 21600) * 1000).toISOString(),
      minted_at: new Date().toISOString()
    });
    won++;
    console.log(`  + ${tok.email || tok.account_id || dc.user_code}`);
  }
  console.log(`\nharvested ${won}/${codes.length} accounts -> ${OUT}`);
}

async function refreshAll(accountsFile) {
  const lines = readFileSync(accountsFile, 'utf8').split('\n').filter(Boolean);
  console.log(`refreshing ${lines.length} account(s)...`);
  let refreshed = 0;
  mkdirSync(dirname(OUT), { recursive: true });
  // Buffered writes: in-place append would double the file. Read all, rewrite.
  const out = [];
  for (const line of lines) {
    let acc;
    try { acc = JSON.parse(line); } catch { out.push(line); continue; }
    if (!acc.refresh_token) { out.push(line); continue; }
    const r = await post('/auth/device/token', {
      grant_type: REFRESH_GRANT,
      refresh_token: acc.refresh_token,
      client_id: CLIENT_ID
    });
    if (r.status !== 200) { out.push(line); continue; }
    const next = {
      email: r.json.email || acc.email || acc.account_id || '',
      access_token: r.json.access_token,
      refresh_token: r.json.refresh_token || acc.refresh_token,
      id_token: r.json.id_token || '',
      expires_in: r.json.expires_in,
      expires_at: new Date(Date.now() + (r.json.expires_in ?? 21600) * 1000).toISOString(),
      minted_at: acc.minted_at,
      refreshed_at: new Date().toISOString()
    };
    out.push(JSON.stringify(next));
    refreshed++;
  }
  writeFileSync(accountsFile, out.join('\n') + '\n');
  console.log(`refreshed ${refreshed}/${lines.length} account(s) -> ${accountsFile}`);
}

(async () => {
  if (flag('interactive') >= 0) return interactive();
  if (flag('refresh') >= 0) {
    const f = val('refresh') || OUT;
    return refreshAll(f);
  }
  if (flag('harvest') >= 0) {
    const f = val('harvest');
    if (!f) throw new Error('--harvest needs a pending file path');
    return harvest(f);
  }
  if (flag('batch') >= 0) {
    const n = Number(val('batch') ?? 1);
    const f = val('pending');
    if (!f) throw new Error('--batch needs --pending <file>');
    return batch(n, f);
  }
  console.log('usage: opencode-farm.mjs --interactive | --batch N --pending F | --harvest F | --refresh [F]');
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });