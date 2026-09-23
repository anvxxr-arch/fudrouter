// Create ONE throwaway session for authed-page audits.
// better-auth rate-limits rapid signups — one user, role switched in DB between batches.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const EMAIL = `fox-audit-${Date.now()}@probe.local`;
const PASS = 'AuditProbe!2026x';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const res = await page.request.post(`${BASE}/api/auth/sign-up/email`, {
  data: { email: EMAIL, password: PASS, name: 'Audit Probe' },
  headers: { Origin: BASE }
});
console.log('signup status:', res.status());
const body = await res.text();
console.log('signup body:', body.slice(0, 200));

if (res.status() >= 400) {
  console.log('SIGNUP FAILED — cannot audit authed pages');
  process.exit(1);
}

// session cookie
const cookies = await ctx.cookies();
const sess = cookies.find((c) => c.name.includes('session_token'));
if (!sess) {
  console.log('NO SESSION COOKIE — cookies seen:', cookies.map((c) => c.name));
  process.exit(1);
}
writeFileSync('/tmp/fr_session.txt', sess.value);
writeFileSync('/tmp/fr_audit_email.txt', EMAIL);
console.log('session saved. email:', EMAIL);
await browser.close();
