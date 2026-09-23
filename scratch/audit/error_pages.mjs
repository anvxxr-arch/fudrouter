// Error-page audit: 404 (real) + a11y + title + overflow. 500 branch can't be
// triggered externally without breaking prod — check the +error.svelte renders via 404 path.
import { chromium } from 'playwright';
const browser = await chromium.launch();

// 404
const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
const page = await ctx.newPage();
const resp = await page.goto('https://ai.karepmuwes.my.id/no-such-page-xyz', { waitUntil: 'networkidle' }).catch((e) => null);
const r404 = await page.evaluate(() => ({
  status: 'see resp',
  title: document.title,
  h1: document.querySelector('h1')?.textContent,
  bodyLen: document.body.innerText.length,
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  hasNav: !!document.querySelector('header, nav'),
  skipLink: !!document.querySelector('.skip-link, a[href="#content"]')
}));
console.log('404 http:', resp?.status(), JSON.stringify(r404));

// 500: force via a server error is invasive; instead verify the error boundary exists
// and renders for a malformed action POST (SvelteKit returns 400/403 handled pages)
const page2 = await ctx.newPage();
const resp2 = await page2.goto('https://ai.karepmuwes.my.id/keys/nonexistent-id-xyz', { waitUntil: 'networkidle' }).catch(() => null);
console.log('/keys/<bad-id> (unauth):', resp2?.status(), '->', new URL(page2.url()).pathname);
await browser.close();
