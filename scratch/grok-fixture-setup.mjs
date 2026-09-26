// Fixture for exercising import-grok-pool's candidate fallback, without touching
// the real pool. Creates provider `xai-grok-test` and a tiny credential dir.
//
//   fox-dead@test.dev     only a garbage token            -> must be DROPPED
//   fox-fallback@test.dev a DEAD token stamped with the   -> must be KEPT via the
//                         LATER expiry, plus a live one      older live candidate
//
// The live candidate is borrowed from the real pool, so after the run its rotated
// token has to go back (see verify-and-fixup.mjs) — one account, one copy.
import postgres from "postgres";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
const FIX = "/tmp/grokfixture";
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

const sql = postgres(DSN);
try {
  // one live pair to borrow, straight out of the pool
  const [row] =
    await sql`select credentials_enc from provider where name='xai-grok'`;
  const real = JSON.parse(dec(row.credentials_enc));
  const live = real.accounts.find((a) => a.email && a.refresh_token);
  if (!live) {
    console.error("no live account to borrow");
    process.exit(1);
  }
  writeFileSync(
    "/tmp/grokfixture-borrowed.json",
    JSON.stringify({ email: live.email }),
  );
  console.log(`borrowed live account: ${live.email}`);

  const blob = {
    api_key: live.access_token,
    auth_kind: "oauth",
    default_headers: real.default_headers,
    accounts: [
      {
        email: "fox-dead@test.dev",
        access_token: "",
        refresh_token: "not-a-real-refresh-token",
        id_token: "",
        expired: "2026-01-01T00:00:00Z",
      },
      // the bug: a dead token that looks NEWER than the live one
      {
        email: "fox-fallback@test.dev",
        access_token: "",
        refresh_token: "not-a-real-refresh-token",
        id_token: "",
        expired: "2030-01-01T00:00:00Z",
      },
      {
        email: "fox-fallback@test.dev",
        access_token: live.access_token,
        refresh_token: live.refresh_token,
        id_token: "",
        expired: "2026-01-01T00:00:00Z",
      },
    ],
  };

  await sql`delete from provider where name = 'xai-grok-test'`;
  await sql`insert into provider (id, name, base_url, credentials_enc, status, priority)
	          values ('fox-test-provider', 'xai-grok-test', 'https://cli-chat-proxy.grok.com/v1', ${enc(JSON.stringify(blob))}, 'dev', 100)`;
  console.log("provider xai-grok-test created (3 candidate rows, 2 emails)");

  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
  // a file copy of the dead one, so the harvest path is exercised too
  writeFileSync(
    `${FIX}/dead.json`,
    JSON.stringify({
      email: "fox-dead@test.dev",
      refresh_token: "not-a-real-refresh-token",
      expired: "2026-01-01T00:00:00Z",
    }),
  );
  console.log(`fixture dir: ${FIX} (1 file)`);
} finally {
  await sql.end();
}
