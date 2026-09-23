import { chromium } from 'playwright';
const browser = await chromium.launch();
for (const path of ['/pricing', '/models']) {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await page.goto('https://ai.karepmuwes.my.id' + path, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => {
    const grid = document.querySelector('.pricing-grid, .model-grid');
    const card = grid?.firstElementChild;
    const gs = grid ? getComputedStyle(grid) : null;
    const cs = card ? getComputedStyle(card) : null;
    const gridR = grid?.getBoundingClientRect();
    const cardR = card?.getBoundingClientRect();
    // widest unbreakable child inside card
    let widest = { w: 0, text: '' };
    card?.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > widest.w) widest = { w: Math.round(r.width), text: el.textContent.trim().slice(0, 30) };
    });
    // find the .slug computed overflow-wrap
    const slug = card?.querySelector('.slug');
    return {
      gridW: Math.round(gridR?.width || 0),
      gridCols: gs?.gridTemplateColumns,
      cardW: Math.round(cardR?.width || 0),
      cardMinW: cs?.minWidth,
      slugWrap: slug ? getComputedStyle(slug).overflowWrap : 'n/a',
      slugW: slug ? Math.round(slug.getBoundingClientRect().width) : 0,
      widest
    };
  });
  console.log(path, JSON.stringify(info, null, 1));
  await page.close();
}
await browser.close();
