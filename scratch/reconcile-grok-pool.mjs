// Reconcile the xai-grok pool from BOTH sources, trying every candidate token.
//
// Why this exists: the DB blob and the farm's credential files can hold DIFFERENT
// refresh tokens for the same email (the DB's is the later `expired`), and the
// later one is not always the live one. import-grok-pool.mjs merges by "later
// expired wins" and then health-checks exactly one token per email, so a dead
// newer copy makes it drop an account whose file token still refreshes.
//
// Here: for each email, try the file's token first, then the DB's, keep whichever
// refreshes (a successful refresh is a rotation — always persisted), drop the
// rest. Results stream to a JSONL file as they land, so an interrupted run loses
// nothing: rebuild the blob from the JSONL with --from-jsonl.
//
//   node reconcile-grok-pool.mjs --files DIR [--workers N] [--dry-run]
//   node reconcile-grok-pool.mjs --from-jsonl PATH
import postgres from "postgres";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  appendFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const PROVIDER = process.env.XAI_PROVIDER_NAME || "xai-grok";
const CLIENT_ID =
  process.env.XAI_OAUTH_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_ENDPOINT =
  process.env.XAI_TOKEN_ENDPOINT || "https://auth.x.ai/oauth2/token";
const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
if (!MASTER) {
  console.error("missing env: CREDENTIALS_MASTER_KEY");
  process.exit(1);
}
if (!DSN) {
  console.error("missing env: DATABASE_URL");
  process.exit(1);
}

const argv = process.argv.slice(2);
let dirs = [],
  workers = 6,
  dryRun = false,
  fromJsonl = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--files") dirs.push(argv[++i]);
  else if (a === "--workers") workers = Number(argv[++i]) || 6;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--from-jsonl") fromJsonl = argv[++i];
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
const JSONL = "/home/dwizzy/grok-build-import/reconcile.jsonl";

function key() {
  const k = Buffer.from(MASTER, "base64");
  if (k.length !== 32) throw new Error("bad master key");
  return k;
}
function decrypt(wire) {
  const raw = Buffer.from(wire, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([
    d.update(raw.subarray(12, raw.length - 16)),
    d.final(),
  ]).toString("utf8");
}
function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([
    iv,
    c.update(plain, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
async function refresh(rt) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: CLIENT_ID,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let why = text.slice(0, 100);
    try {
      const j = JSON.parse(text);
      why = j.error_description || j.error || why;
    } catch {}
    return { ok: false, error: why };
  }
  const j = JSON.parse(text);
  if (!j.access_token) return { ok: false, error: "no access_token" };
  return {
    ok: true,
    access_token: j.access_token,
    refresh_token: j.refresh_token || rt,
    expires_in: j.expires_in || 21600,
  };
}

const sql = postgres(DSN);
try {
  const rows =
    await sql`select id, credentials_enc from provider where name = ${PROVIDER}`;
  if (!rows.length) {
    console.error(`provider not found: ${PROVIDER}`);
    process.exit(1);
  }
  const providerID = rows[0].id;
  const blob = JSON.parse(decrypt(rows[0].credentials_enc));

  if (fromJsonl) {
    const kept = readFileSync(fromJsonl, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    if (!kept.length) {
      console.error("jsonl empty — refusing to write");
      process.exit(1);
    }
    kept.sort((a, b) => a.email.localeCompare(b.email));
    const out = {
      api_key: kept[0].access_token,
      auth_kind: "oauth",
      default_headers: blob.default_headers,
      accounts: kept,
    };
    await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(out))} where id = ${providerID}`;
    const [v] =
      await sql`select credentials_enc from provider where id = ${providerID}`;
    console.log(
      `wrote ${JSON.parse(decrypt(v.credentials_enc)).accounts.length} account(s) from ${fromJsonl} (verified by re-read)`,
    );
    process.exit(0);
  }

  // ---- candidates: file token first, then the DB's, per email ----
  const byEmail = new Map();
  for (const d of dirs) {
    let n = 0;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      let c;
      try {
        c = JSON.parse(readFileSync(join(d, f), "utf8"));
      } catch {
        continue;
      }
      if (!c.email || !c.refresh_token) continue;
      n++;
      const cur = byEmail.get(c.email) || [];
      cur.push({ source: `file:${d}`, token: c.refresh_token });
      byEmail.set(c.email, cur);
    }
    console.log(`files ${d}: ${n} credential(s)`);
  }
  for (const a of blob.accounts || []) {
    if (!a.email || !a.refresh_token) continue;
    const cur = byEmail.get(a.email) || [];
    cur.push({ source: "db", token: a.refresh_token });
    byEmail.set(a.email, cur);
  }
  let multi = 0,
    tokens = 0;
  for (const v of byEmail.values()) {
    tokens += v.length;
    if (v.length > 1) multi++;
  }
  console.log(
    `union: ${byEmail.size} email(s), ${tokens} token candidate(s), ${multi} with more than one`,
  );
  if (dryRun) {
    console.log(
      `[dry-run] would try every candidate token (files before db), keep the ones that refresh; nothing rotated`,
    );
    process.exit(0);
  }

  // ---- health check every candidate, stream results ----
  if (existsSync(JSONL)) rmSync(JSONL);
  const items = [...byEmail.entries()];
  let idx = 0,
    kept = 0,
    dead = 0;
  const errs = new Map();
  async function worker(id) {
    while (idx < items.length) {
      const [email, cands] = items[idx++];
      let done = false;
      for (const c of cands) {
        const r = await refresh(c.token);
        if (r.ok) {
          const rec = {
            email,
            access_token: r.access_token,
            refresh_token: r.refresh_token,
            id_token: "",
            expired: new Date(Date.now() + r.expires_in * 1000)
              .toISOString()
              .replace(/\.\d+Z$/, "Z"),
            source: c.source,
          };
          appendFileSync(JSONL, JSON.stringify(rec) + "\n");
          kept++;
          done = true;
          break;
        }
        const k = `${String(r.error).replace(/\d+/g, "N").slice(0, 55)}`;
        errs.set(k, (errs.get(k) || 0) + 1);
      }
      if (!done) dead++;
      if ((kept + dead) % 100 === 0)
        console.log(
          `  ...${kept + dead}/${items.length} (kept ${kept}, dead ${dead})`,
        );
    }
  }
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  console.log(`\nkept: ${kept}   dead: ${dead}`);
  for (const [k, n] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`   ${String(n).padStart(4)}x ${k}`);
  if (!kept) {
    console.error("no live account — refusing to write");
    process.exit(1);
  }

  const accs = readFileSync(JSONL, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  accs.sort((a, b) => a.email.localeCompare(b.email));
  const out = {
    api_key: accs[0].access_token,
    auth_kind: "oauth",
    default_headers: blob.default_headers,
    accounts: accs,
  };
  await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(out))} where id = ${providerID}`;
  const [v] =
    await sql`select credentials_enc from provider where id = ${providerID}`;
  const back = JSON.parse(decrypt(v.credentials_enc));
  console.log(
    `wrote ${back.accounts.length} account(s) (verified by re-read); jsonl kept at ${JSONL}`,
  );
} finally {
  await sql.end();
}
