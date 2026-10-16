// Lists pages of the running demo that still print KG / coffee wording for a non-coffee company.
import { chromium } from '@playwright/test';
const BASE = process.argv[2] ?? 'http://localhost:3399';
const paths = ['/dashboard','/purchases','/shipments','/inventory','/inventory/movements','/inventory/batches','/sales','/receivables','/profitability','/items','/customers','/vendors','/loading','/finance/expenses','/reports/inventory-valuation','/reports/cogs','/reports/shipment-cost','/reports/stock-movement','/reports/sales-by','/trace'];
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1920, height: 1080 } });
const p = await c.newPage();
await p.goto(BASE + '/login'); await p.getByRole('button', { name: 'Explore the demo' }).click(); await p.waitForURL('**/dashboard');
for (const path of paths) {
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  const t = await p.locator('main').innerText().catch(() => '');
  const hits = [...t.matchAll(/.{0,28}(\bKG\b|\bkg\b|[Cc]offee|\bbags?\b).{0,20}/g)].map((m) => m[0].replace(/\s+/g, ' '));
  console.log(path, hits.length ? '\n   ' + hits.slice(0, 4).join('\n   ') : 'ok');
}
await b.close();
