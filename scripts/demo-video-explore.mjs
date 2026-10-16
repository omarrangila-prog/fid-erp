import { chromium } from '@playwright/test';
const OUT = process.argv[2];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3399/login');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/login.png` });
await page.getByRole('button', { name: 'Explore the demo' }).click();
await page.waitForURL('**/dashboard', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/dashboard.png` });
for (const [name, path] of [['purchases','/purchases'],['shipments','/shipments'],['inventory','/inventory'],['sales','/sales'],['receivables','/finance/receivables'],['profitability','/profitability'],['pnl','/reports/profit-loss'],['reports','/reports'],['items','/items']]) {
  await page.goto('http://localhost:3399'+path); await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
await b.close();
