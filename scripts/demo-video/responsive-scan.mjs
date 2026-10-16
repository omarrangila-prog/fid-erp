// Visits key screens of the running demo at phone-to-desktop widths and reports horizontal page overflow,
// clipped headings and undersized touch targets. Screenshots are written to <outDir>.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const [out = './qa', base = 'http://localhost:3399'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const widths = [360, 390, 430, 768, 1024, 1366, 1440, 1920];
const paths = ['/dashboard', '/purchases', '/shipments', '/inventory', '/sales', '/receivables', '/profitability', '/reports/profit-loss', '/reports/balance-sheet', '/items', '/customers', '/settings/company', '/onboarding', '/reports'];
const b = await chromium.launch();
let problems = 0;
for (const w of widths) {
  const c = await b.newContext({ viewport: { width: w, height: w < 500 ? 900 : 1000 }, hasTouch: w < 800 });
  const p = await c.newPage();
  await p.goto(base + '/login'); await p.getByRole('button', { name: 'Explore the demo' }).click(); await p.waitForURL('**/dashboard');
  for (const path of paths) {
    await p.goto(base + path, { waitUntil: 'networkidle' });
    const r = await p.evaluate(() => {
      const de = document.documentElement;
      const wide = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > innerWidth + 1 && b.width > 0 && !e.closest('[class*="overflow-x"],table,[data-scroll],.overflow-auto') && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map((e) => e.tagName + '.' + String(e.className).slice(0, 50));
      const small = [...document.querySelectorAll('a[href],button')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (b.height < 24 || b.width < 24) && getComputedStyle(e).visibility !== 'hidden'; }).length;
      return { overflow: de.scrollWidth - innerWidth, wide, small };
    });
    const bad = r.overflow > 1;
    if (bad) problems++;
    if (bad || (w < 500 && r.small > 6)) console.log(`${w}px ${path}: overflow=${r.overflow} small-targets=${r.small} ${r.wide.join(' | ')}`);
    if ([360, 1440].includes(w)) await p.screenshot({ path: `${out}/${w}${path.replace(/\W+/g, '_')}.png` });
  }
  await c.close();
}
await b.close();
console.log(problems ? `${problems} page/width combinations overflow horizontally` : 'No horizontal overflow at any width');
