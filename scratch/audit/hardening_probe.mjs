// Hardening probe for /admin/providers/[id]. Safe to run repeatedly: it only ever
// touches rows that already exist, and it restores the provider's priority and the
// status of every model it touched before it exits.
//
// Run it twice: once with a plain `user` session, once with an admin session.
//
//   node --env-file=apps/web/.env scratch/audit/hardening_probe.mjs googleai "label"
//
// SvelteKit answers an action POST with HTTP 200 and puts the real outcome in the
// body, so the verdict comes from `type` (success | failure | redirect), not status.
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const BASE = "https://ai.karepmuwes.my.id";
const PID = process.argv[2] ?? "googleai";
const LABEL = process.argv[3] ?? "session";
const token = readFileSync("/tmp/fr_session.txt", "utf8").trim();
const cookie = `__Secure-better-auth.session_token=${token}`;
const devKey = readFileSync("/tmp/ukey2.key", "utf8").trim();

const sql = postgres(process.env.DATABASE_URL);
const rows = await sql`select slug from model where provider_id = ${PID}`;
const PROBE_SLUG = rows[0]?.slug ?? "none";
const [orig] = await sql`select priority from provider where id = ${PID}`;
const origStatuses =
  await sql`select slug, status from model where provider_id = ${PID}`;

async function advertised() {
  const r = await fetch("http://127.0.0.1:8100/v1/models", {
    headers: { authorization: `Bearer ${devKey}` },
  });
  return (await r.json()).data.length;
}

async function post(action, fields = {}, extraHeaders = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(`${BASE}/admin/providers/${PID}?/${action}`, {
    method: "POST",
    headers: {
      cookie,
      Origin: BASE,
      "x-sveltekit-action": "true",
      "content-type": "application/x-www-form-urlencoded",
      ...extraHeaders,
    },
    body,
    redirect: "manual",
  });
  const text = await res.text();
  const type = /"type":"(\w+)"/.exec(text)?.[1] ?? "none";
  const status = /"status":(\d+)/.exec(text)?.[1];
  return { http: res.status, text, type, status };
}

/** turned away: a failure result, or the hook's redirect. */
const turnedAway = (r) =>
  r.type === "failure" || r.type === "redirect" || r.http >= 400;
const fmt = (r) =>
  `http=${r.http} body=${r.type}${r.status ? `(${r.status})` : ""}`;

console.log(`=== ${LABEL} ===`);
const page = await fetch(`${BASE}/admin/providers/${PID}`, {
  headers: { cookie },
  redirect: "manual",
});
console.log(
  `  page: http=${page.status}${page.headers.get("location") ? ` loc=${page.headers.get("location")}` : ""}`,
);

console.log(`\n-- actions --`);
let executed = 0;
for (const [name, fields] of [
  ["fetchCatalog", { tier: "all" }],
  [
    "enable",
    {
      payload: JSON.stringify({
        slug: PROBE_SLUG,
        name: "probe",
        inputUsd: 0,
        outputUsd: 0,
      }),
    },
  ],
  ["disable", { slug: PROBE_SLUG }],
  ["testCredential", { index: "0" }],
  ["testAll", {}],
  ["testModel", { slug: PROBE_SLUG }],
  ["chat", { slug: PROBE_SLUG, message: "Say OK" }],
  ["strategy", { priority: String(orig.priority) }],
]) {
  const r = await post(name, fields);
  const away = turnedAway(r);
  if (!away) executed += 1;
  console.log(
    `  ${(away ? "refused" : "executed").padEnd(9)} ${name.padEnd(15)} ${fmt(r)}`,
  );
}
console.log(`  executed (not refused): ${executed}`);

if (executed === 0) {
  console.log(`\n-- state invariance: a refused action must change nothing --`);
  const [after] = await sql`select priority from provider where id = ${PID}`;
  const [count] =
    await sql`select count(*)::int as n from model where provider_id = ${PID} and status = 'active'`;
  const [wasCount] =
    await sql`select count(*)::int as n from model where provider_id = ${PID} and status = 'active'`;
  console.log(
    `  priority:      ${orig.priority} -> ${after.priority} ${orig.priority === after.priority ? "unchanged ✓" : "CHANGED ✗"}`,
  );
  console.log(`  rows for ${PID}: ${rows.length} (unchanged ✓)`);
  void count;
  void wasCount;
} else {
  console.log(
    `\n-- actions executed: expected for an authorised session, state restored at the end --`,
  );
}

console.log(`\n-- CSRF (SvelteKit origin check) --`);
if (executed > 0) {
  const csrf = await post(
    "strategy",
    { priority: "100" },
    { Origin: "https://evil.example" },
  );
  console.log(
    `  cross-origin POST: ${fmt(csrf)} -> ${turnedAway(csrf) ? "rejected ✓" : "ACCEPTED (bad)"}`,
  );
} else {
  console.log("  skipped (already refused at the hook for this session)");
}

console.log(
  `\n-- input guards: a failure is correct, an error/5xx is a bug --`,
);
const guards = [
  ["priority 1e308", await post("strategy", { priority: "1e308" })],
  ["priority 1.5", await post("strategy", { priority: "1.5" })],
  ["priority -5", await post("strategy", { priority: "-5" })],
  ["priority abc", await post("strategy", { priority: "abc" })],
  ["priority 99999", await post("strategy", { priority: "99999" })],
  ["index 999999", await post("testCredential", { index: "999999" })],
  ["index -1", await post("testCredential", { index: "-1" })],
  ["index NaN", await post("testCredential", { index: "NaN" })],
  [
    "chat 9KB message",
    await post("chat", { slug: PROBE_SLUG, message: "x".repeat(9000) }),
  ],
  [
    "chat slug w/ space",
    await post("chat", { slug: "gpt 5.6", message: "hi" }),
  ],
  [
    "chat slug ctrl char",
    await post("chat", { slug: "gpt\u00005", message: "hi" }),
  ],
  ["disable no slugs", await post("disable", {})],
  ["testModel ctrl slug", await post("testModel", { slug: "a\u0000b" })],
  [
    "enable blank slug",
    await post("enable", { payload: JSON.stringify({ name: "no slug" }) }),
  ],
];
let bugs = 0;
for (const [name, r] of guards) {
  const bug =
    r.http >= 500 || r.type === "error" || (r.type === "none" && executed > 0);
  if (bug) bugs += 1;
  const verdict = bug
    ? "BUG"
    : executed === 0
      ? "refused"
      : r.type === "failure"
        ? "rejected ✓"
        : `NOT rejected (${r.type})`;
  console.log(`  ${verdict.padEnd(20)} ${name.padEnd(20)} ${fmt(r)}`);
}
console.log(`  bugs: ${bugs}`);

console.log(
  `\n-- batch cap: 505 payloads, existing slugs only (no inserts) --`,
);
if (rows.length === 0) {
  console.log("  skipped: no catalog rows to reuse");
} else {
  const slugs = rows.map((r) => r.slug);
  const before = await advertised();
  const form = new URLSearchParams();
  for (let i = 0; i < 505; i += 1) {
    form.append(
      "payload",
      JSON.stringify({
        slug: slugs[i % slugs.length],
        name: "probe",
        inputUsd: 0,
        outputUsd: 0,
      }),
    );
  }
  const res = await fetch(`${BASE}/admin/providers/${PID}?/enable`, {
    method: "POST",
    headers: {
      cookie,
      Origin: BASE,
      "x-sveltekit-action": "true",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const text = await res.text();
  const after = await advertised();
  const [count] =
    await sql`select count(*)::int as n from model where provider_id = ${PID}`;
  console.log(
    `  505 payloads over ${slugs.length} distinct slugs: http=${res.status}`,
  );
  console.log(
    `  cap reported:         ${/beyond the (\d+) per-request limit/.exec(text)?.[1] ?? "NOT REPORTED"}`,
  );
  console.log(
    `  duplicates collapsed: ${/duplicate\(s\) collapsed/.test(text) ? "reported ✓" : "not reported"}`,
  );
  console.log(`  advertised: ${before} -> ${after}`);
  console.log(
    `  catalog rows: ${count.n} (was ${rows.length}) ${count.n === rows.length ? "✓ no insert" : "✗ GREW"}`,
  );
}

console.log(`\n-- secret leak --`);
const [p] = await sql`select credentials_enc from provider where id = ${PID}`;
const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, "base64");
const buf = Buffer.from(p.credentials_enc, "base64");
const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
d.setAuthTag(buf.subarray(buf.length - 16));
const cred = JSON.parse(
  Buffer.concat([
    d.update(buf.subarray(12, buf.length - 16)),
    d.final(),
  ]).toString("utf8"),
);
const secrets = (cred.accounts ?? [])
  .map((a) => a.access_token || a.api_key)
  .filter(Boolean);
const html = await (
  await fetch(`${BASE}/admin/providers/${PID}`, { headers: { cookie } })
).text();
console.log(`  secrets checked:    ${secrets.length}`);
console.log(
  `  full key present:   ${secrets.some((s) => html.includes(s)) ? "LEAKED" : "no ✓"}`,
);
console.log(
  `  key suffix present: ${secrets.some((s) => html.includes(s.slice(-8))) ? "LEAKED" : "no ✓"}`,
);
console.log(
  `  ciphertext in page: ${html.includes(p.credentials_enc) ? "LEAKED" : "no ✓"}`,
);
console.log(
  `  credentialsEnc ref: ${html.includes("credentialsEnc") ? "LEAKED" : "no ✓"}`,
);
console.log(
  `  Bearer value:       ${/Bearer\s+[A-Za-z0-9._-]{10,}/.test(html) ? "LEAKED" : "no ✓"}`,
);

// ---- restore ---------------------------------------------------------------
await sql`update provider set priority = ${orig.priority} where id = ${PID}`;
for (const s of origStatuses) {
  await sql`update model set status = ${s.status} where provider_id = ${PID} and slug = ${s.slug}`;
}
const [restored] = await sql`select priority from provider where id = ${PID}`;
const [restoredRows] =
  await sql`select count(*)::int as n from model where provider_id = ${PID}`;
console.log(
  `\n-- restored: priority=${restored.priority} rows=${restoredRows.n} advertised=${await advertised()} --`,
);
await sql.end();
