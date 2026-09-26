// 1. Prove the test provider kept the RIGHT account.
// 2. Copy the borrowed account's rotated token back into the real pool (the test
//    rotated it; the pool's copy would otherwise be stale and die).
// 3. Drop the test provider and the fixture dir.
import postgres from "postgres";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";

const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
function key() {
  return Buffer.from(MASTER, "base64");
}
function dec(wire) {
  const raw = Buffer.from(wire, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([
    d.update(raw.subarray(12, raw.length - 16)),
    d.final(),
  ]).toString("utf8");
}
function enc(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([
    iv,
    c.update(plain, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}

const borrowed = JSON.parse(
  readFileSync("/tmp/grokfixture-borrowed.json", "utf8"),
).email;
const sql = postgres(DSN);
try {
  const [t] =
    await sql`select credentials_enc from provider where name='xai-grok-test'`;
  const test = JSON.parse(dec(t.credentials_enc));
  const keptEmails = test.accounts.map((a) => a.email);
  const pass =
    keptEmails.length === 1 && keptEmails[0] === "fox-fallback@test.dev";
  console.log(`test provider kept: ${JSON.stringify(keptEmails)}`);
  console.log(
    `EXPECTED [fox-fallback@test.dev] (the older live candidate behind a dead newer one): ${pass ? "PASS" : "FAIL"}`,
  );
  if (!pass) {
    console.error(
      "fixture verdict unexpected — stopping before touching the real pool",
    );
    process.exit(1);
  }

  // ---- put the borrowed account back, with its rotated token ----
  const [r] =
    await sql`select id, credentials_enc from provider where name='xai-grok'`;
  const real = JSON.parse(dec(r.credentials_enc));
  const who = test.accounts[0];
  const idx = real.accounts.findIndex((a) => a.email === borrowed);
  if (idx < 0) {
    console.error(`borrowed account ${borrowed} not found in the real pool`);
    process.exit(1);
  }
  const before = {
    rt: real.accounts[idx].refresh_token.slice(0, 10),
    exp: real.accounts[idx].expired,
  };
  // the test's kept row carries the borrowed account's rotated chain; its email is
  // the fixture's, so copy the TOKENS only
  real.accounts[idx] = {
    ...real.accounts[idx],
    access_token: who.access_token,
    refresh_token: who.refresh_token,
    expired: who.expired,
  };
  await sql`update provider set credentials_enc = ${enc(JSON.stringify(real))} where id = ${r.id}`;
  const [v] =
    await sql`select credentials_enc from provider where id = ${r.id}`;
  const back = JSON.parse(dec(v.credentials_enc));
  const now = back.accounts.find((a) => a.email === borrowed);
  console.log(
    `restored ${borrowed}: rt ${before.rt}… -> ${now.refresh_token.slice(0, 10)}…, expired ${before.exp} -> ${now.expired}`,
  );
  console.log(`pool now ${back.accounts.length} account(s), re-read verified`);

  await sql`delete from provider where name='xai-grok-test'`;
  const [{ n }] =
    await sql`select count(*)::int as n from provider where name like 'xai-grok%'`;
  console.log(`test provider deleted; providers named xai-grok*: ${n}`);
  rmSync("/tmp/grokfixture", { recursive: true, force: true });
  rmSync("/tmp/grokfixture-borrowed.json", { force: true });
} finally {
  await sql.end();
}
