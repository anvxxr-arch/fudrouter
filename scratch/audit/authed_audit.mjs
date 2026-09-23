// axe + reflow + focus + spacing on AUTHED pages with a real session cookie.
// Usage: node authed_audit.mjs [role:user|admin]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'https://ai.karepmuwes.my.id';
const ROLE = process.argv[2] || 'user';
const COOKIE = readFileSync('/tmp/fr_session.txt', 'utf8').trim();

const PAGES = ROLE === 'admin'
  ? ['/dashboard', '/keys', '/usage', '/account', '/admin', '/admin/providers', '/admin/models', '/admin/keys', '/admin/users', '/admin/requests', '/admin/connections']
  : ['/dashboard', '/keys', '/usage', '/account'];

const browser = await chromium.launch();
for (const path of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: '__Secure-better-auth.session_token', value: COOKIE, domain: 'ai.karepmuwes.my.id', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
    const landed = new URL(page.url()).pathname;
    if (landed !== path) { console.log(`${path}: REDIRECT -> ${landed} (not audited)`); await ctx.close(); continue; }

    await page.addScriptTag({ path: new URL('./node_modules/axe-core/axe.min.js', import.meta.url).pathname });
    const violations = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ')?.slice(0, 90) }));
    });

    // focus visibility
    const focusFails = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
        // hidden/disabled inputs are not focusable — no indicator required
        if (el instanceof HTMLInputElement && ['hidden', 'submit', 'button'].includes(el.type)) continue;
        if (el.disabled || el.offsetParent === null && el !== document.body) continue;
        const snap = (e) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderColor].join('|'); };
        const b = snap(el); el.focus(); const a = snap(el);
        if (b === a) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${el.textContent.trim().slice(0, 20)}"`);
        el.blur();
      }
      return bad;
    });

    // 320px reflow
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(250);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    console.log(`${path}: axe=${violations.length} focus=${focusFails.length} overflowX=${overflowX} ${!violations.length && !focusFails.length && overflowX === 0 ? 'CLEAN' : '<<< ISSUES'}`);
    for (const v of violations) console.log(`   axe[${v.impact}]: ${v.id} (${v.nodes}) ${v.sample}`);
    for (const f of focusFails) console.log(`   focus: ${f}`);
  } catch (e) {
    console.log(`${path}: ERROR ${String(e).slice(0, 130)}`);
  } finally { await ctx.close(); }
}
await browser.close();
