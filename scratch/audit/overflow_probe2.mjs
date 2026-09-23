// Find the remaining 8px overflow on /pricing and /models at 320px.
import { chromium } from 'playwright';
const BASE = 'https://ai.karepmuwes.my.id';
const browser = await chromium.launch();
for (const path of ['/pricing', '/models']) {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).split(' ').slice(0, 2).join('.'),
          text: el.textContent?.trim().slice(0, 25),
          right: Math.round(r.right), w: Math.round(r.width)
        });
      }
    }
    return { vw, scrollW: document.documentElement.scrollWidth, n: out.length, out: out.slice(0, 6) };
  });
  console.log(path, JSON.stringify(info, null, 1));
  await page.close();
}
await browser.close();
