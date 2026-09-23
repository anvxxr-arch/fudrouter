// Find exactly which elements overflow the 320px viewport.
import { chromium } from 'playwright';
const BASE = 'https://ai.karepmuwes.my.id';
const browser = await chromium.launch();
for (const path of ['/', '/pricing', '/models']) {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const culprits = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        // only leaf-ish offenders: no child that also overflows further
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).split(' ').slice(0, 2).join('.'),
          text: el.textContent?.trim().slice(0, 30),
          left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width)
        });
      }
    }
    // dedupe: keep the deepest 6
    return { vw, scrollW: document.documentElement.scrollWidth, out: out.slice(-8) };
  });
  console.log(path, JSON.stringify(culprits, null, 1));
  await page.close();
}
await browser.close();
