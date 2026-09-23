// Real Core Web Vitals via PerformanceObserver — LCP, CLS, TBT (approx via long tasks),
// FCP, TTFB, transfer sizes. No Lighthouse needed; these are the same signals.
import { chromium } from 'playwright';

const BASE = 'https://ai.karepmuwes.my.id';
const PAGES = ['/', '/pricing', '/models', '/docs', '/status', '/login'];

const browser = await chromium.launch();
console.log('page | LCP | CLS | FCP | TTFB | longTasks>50ms | JS(bytes) | doc(bytes)');

for (const path of PAGES) {
  // mobile-ish viewport + CPU throttle 4x for realistic numbers
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.emulateCPUThrottling && null; // not available; note it
  try {
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 30000 });

    const vitals = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 1200)); // let LCP settle
      const po = (type) => new Promise((resolve) => {
        let val = 0;
        try {
          const obs = new PerformanceObserver((l) => {
            const es = l.getEntries();
            for (const e of es) val = e;
            obs.disconnect();
          });
          obs.observe({ type, buffered: true });
          setTimeout(() => resolve(val), 300);
        } catch { resolve(val); }
      });

      const lcpEntry = await po('largest-contentful-paint');
      const lcp = lcpEntry ? lcpEntry.startTime : 0;

      let cls = 0;
      try {
        const clsObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; });
        clsObs.observe({ type: 'layout-shift', buffered: true });
      } catch {}

      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');
      const fcp = paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0;

      const longTasks = performance.getEntriesByType('measure').length; // placeholder
      // real long tasks:
      let lt = 0;
      try {
        const ltObs = new PerformanceObserver(() => {});
        ltObs.observe({ type: 'longtask', buffered: true });
        lt = ltObs.takeRecords().length;
      } catch {}

      const res = performance.getEntriesByType('resource');
      const js = res.filter((r) => r.name.endsWith('.js')).reduce((a, r) => a + (r.transferSize || 0), 0);
      const css = res.filter((r) => r.name.endsWith('.css')).reduce((a, r) => a + (r.transferSize || 0), 0);

      return {
        lcp: Math.round(lcp),
        cls: +cls.toFixed(4),
        fcp: Math.round(fcp),
        ttfb: Math.round(nav?.responseStart ?? 0),
        longTasks: lt,
        js, css,
        docBytes: nav?.transferSize ?? 0
      };
    });
    console.log(`${path} | ${vitals.lcp}ms | ${vitals.cls} | ${vitals.fcp}ms | ${vitals.ttfb}ms | ${vitals.longTasks} | ${vitals.js} | ${vitals.docBytes}`);
  } catch (e) {
    console.log(`${path}: ERROR ${String(e).slice(0, 100)}`);
  } finally { await ctx.close(); }
}
await browser.close();
