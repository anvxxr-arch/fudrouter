// Real axe-core audit against live pages — no hallucination possible.
// Usage: node axe_audit.mjs [base]
// Asserts the landed URL matches the requested path (redirects = measuring the wrong page).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'https://ai.karepmuwes.my.id';
const AXE = new URL('./node_modules/axe-core/axe.min.js', import.meta.url).pathname;

// Public pages + one authed page via session cookie if provided in /tmp/fr_session.txt
const PUBLIC = ['/', '/pricing', '/models', '/docs', '/status', '/login', '/signup', '/legal/terms', '/legal/privacy'];

let cookie = null;
try { cookie = readFileSync('/tmp/fr_session.txt', 'utf8').trim(); } catch {}

const AUTHED = cookie ? ['/dashboard', '/keys', '/usage', '/account'] : [];

const results = [];
const browser = await chromium.launch();
for (const path of [...PUBLIC, ...AUTHED]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (cookie && AUTHED.includes(path)) {
    await ctx.addCookies([{ name: '__Secure-better-auth.session_token', value: cookie, domain: 'ai.karepmuwes.my.id', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }]);
  }
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
    const landed = new URL(page.url()).pathname;
    if (landed !== path && !(path === '/' && landed === '/')) {
      results.push({ path, error: `REDIRECT: landed on ${landed} — not audited` });
      continue;
    }
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }
      });
      return r.violations.map(v => ({
        id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.length,
        sample: v.nodes[0]?.target?.join(' ')?.slice(0, 100)
      }));
    });
    // 320px reflow check
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(300);
    const reflow = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    results.push({ path, violations, reflow });
  } catch (e) {
    results.push({ path, error: String(e).slice(0, 160) });
  } finally {
    await ctx.close();
  }
}

// touch target probe on landing (2.5.8)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const small = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('a, button, input, select')) {
      const r = el.getBoundingClientRect();
      const inline = el.closest('p, li, td, dd');
      if (!inline && (r.width < 24 || r.height < 24)) bad.push(`${el.tagName}.${el.className?.split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)} "${el.textContent.trim().slice(0, 20)}"`);
    }
    return bad;
  });
  results.push({ path: '(probe) touch targets', small });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 1));
