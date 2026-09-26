import postgres from "postgres";
import { createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MASTER = process.env.CREDENTIALS_MASTER_KEY,
  DSN = process.env.DATABASE_URL;
function dec(wire) {
  const raw = Buffer.from(wire, "base64");
  const iv = raw.subarray(0, 12),
    tag = raw.subarray(raw.length - 16),
    ct = raw.subarray(12, raw.length - 16);
  const d = createDecipheriv("aes-256-gcm", Buffer.from(MASTER, "base64"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
const sql = postgres(DSN);
const [row] =
  await sql`select credentials_enc from provider where name='xai-grok'`;
const blob = JSON.parse(dec(row.credentials_enc));
await sql.end();
const DIR = "/home/dwizzy/grok-register/cpa_auths";
const files = new Map();
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
  try {
    const j = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    if (j.email) files.set(j.email, join(DIR, f));
  } catch {}
}
let same = 0,
  diff = 0,
  nofile = 0,
  dbNewer = 0,
  fileNewer = 0,
  dbNewerDead = 0;
const examples = [];
for (const a of blob.accounts || []) {
  const p = files.get(a.email);
  if (!p) {
    nofile++;
    continue;
  }
  const f = JSON.parse(readFileSync(p, "utf8"));
  if (f.refresh_token === a.refresh_token) {
    same++;
    continue;
  }
  diff++;
  const dbExp = String(a.expired || ""),
    fExp = String(f.expired || "");
  if (dbExp > fExp) dbNewer++;
  else fileNewer++;
  if (examples.length < 4)
    examples.push({
      email: a.email,
      db_exp: dbExp,
      file_exp: fExp,
      db_rt: a.refresh_token.slice(0, 10),
      file_rt: f.refresh_token.slice(0, 10),
    });
}
console.log(
  `DB pool: ${(blob.accounts || []).length} akun | file di cpa_auths: ${files.size}`,
);
console.log(`  refresh_token identik: ${same}`);
console.log(
  `  BEDA                : ${diff}   (db lebih baru: ${dbNewer}, file lebih baru: ${fileNewer})`,
);
console.log(`  tidak ada file      : ${nofile}`);
console.log("  contoh:", JSON.stringify(examples, null, 1));
