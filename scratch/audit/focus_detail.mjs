// What are the focus-failing inputs on admin pages?
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const COOKIE = readFileSync('/tmp/fr_session.txt', 'utf8').trim();
const browser = await chromium.launch();
for (const path of ['/admin/models', '/admin/providers', '/admin/keys', '/admin/users', '/admin/connections']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: '__Secure-better-auth.session_token', value: COOKIE, domain: 'ai.karepmuwes.my.id', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  await page.goto('https://ai.karepmuwes.my.id' + path, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => {
    const kinds = {};
    const samples = [];
    for (const el of document.querySelectorAll('input')) {
      const snap = (e) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderColor].join('|'); };
      const b = snap(el); el.focus(); const a = snap(el);
      if (b === a) {
        const k = `${el.type}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`;
        kinds[k] = (kinds[k] || 0) + 1;
        if (samples.length < 2) {
          const r = el.getBoundingClientRect();
          samples.push({ type: el.type, cls: String(el.className).slice(0, 40), visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height), ariaLabel: el.getAttribute('aria-label'), name: el.name, placeholder: el.placeholder?.slice(0, 20) });
        }
      }
      el.blur();
    }
    return { kinds, samples };
  });
  console.log(path, JSON.stringify(info, null, 1));
  await ctx.close();
}
await browser.close();
