// Final browser smoke test of the deployed landing.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://ai.karepmuwes.my.id/', { waitUntil: 'networkidle' });
const r = await page.evaluate(() => ({
  title: document.title,
  h1: document.querySelector('h1')?.textContent,
  jsonLd: !!document.querySelector('script[type="application/ld+json"]'),
  canonical: document.querySelector('link[rel="canonical"]')?.href,
  ogCount: document.querySelectorAll('meta[property^="og:"]').length,
  twitterCount: document.querySelectorAll('meta[name^="twitter:"]').length,
  endpoints: document.querySelectorAll('.endpoint-card').length,
  csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')
}));
console.log(JSON.stringify(r, null, 1));
await browser.close();
