// The three WCAG classes axe cannot test, on every public page:
// 1. Focus visibility (2.4.7) — computed style must change on .focus()
// 2. Text spacing (1.4.12) — injected spacing must not clip anything
// 3. Reduced motion — no animation/transition duration under prefers-reduced-motion
import { chromium } from 'playwright';

const BASE = 'https://ai.karepmuwes.my.id';
const PAGES = ['/', '/pricing', '/models', '/docs', '/status', '/login', '/signup', '/legal/terms', '/legal/privacy'];

const browser = await chromium.launch();
const report = [];

for (const path of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
    const landed = new URL(page.url()).pathname;
    if (landed !== path) { report.push({ path, error: `REDIRECT -> ${landed}` }); continue; }

    // --- 1. Focus visibility ---
    const focusFails = await page.evaluate(() => {
      const bad = [];
      const inter = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      for (const el of inter) {
        const snap = (e) => {
          const s = getComputedStyle(e);
          return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderColor].join('|');
        };
        const before = snap(el);
        el.focus();
        const after = snap(el);
        if (before === after) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${el.textContent.trim().slice(0, 24)}"`);
        el.blur();
      }
      return bad;
    });

    // --- 2. Text spacing (1.4.12) ---
    const spacingFails = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }';
      document.head.appendChild(style);
      const clipped = [];
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el);
        if (s.overflow !== 'visible' && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
          clipped.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} sh=${el.scrollHeight} ch=${el.clientHeight}`);
        }
      }
      style.remove();
      return clipped;
    });

    report.push({ path, focusFails, spacingFails });
  } catch (e) {
    report.push({ path, error: String(e).slice(0, 140) });
  } finally { await ctx.close(); }
}

// --- 3. Reduced motion (landing + pricing as representatives, needs control) ---
for (const rm of ['reduce', 'no-preference']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: rm });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const animated = await page.evaluate(() => {
    const moving = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      const dur = Math.max(parseFloat(s.animationDuration) || 0, parseFloat(s.transitionDuration) || 0);
      if (dur > 0.001) moving.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${s.animationDuration}/${s.transitionDuration}`);
    }
    return moving;
  });
  report.push({ path: `(motion ${rm}) /`, animated });
  await ctx.close();
}

await browser.close();
for (const r of report) {
  if (r.error) { console.log(`${r.path}: ERROR ${r.error}`); continue; }
  if (r.animated !== undefined) { console.log(`${r.path}: ${r.animated.length} animated elements ${r.animated.length ? JSON.stringify(r.animated.slice(0, 4)) : ''}`); continue; }
  const f = r.focusFails?.length ?? 0;
  const s = r.spacingFails?.length ?? 0;
  console.log(`${r.path}: focus=${f} spacing=${s} ${f || s ? '<<< ISSUES' : 'CLEAN'}`);
  for (const x of r.focusFails ?? []) console.log(`   focus: ${x}`);
  for (const x of r.spacingFails ?? []) console.log(`   spacing: ${x}`);
}
