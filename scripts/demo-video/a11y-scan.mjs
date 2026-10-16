// Runs axe-core (WCAG 2.2 A/AA) over key screens of the running demo and lists violations.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const base = process.argv[2] ?? 'http://localhost:3399';
const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const paths = ['/login', '/dashboard', '/purchases', '/shipments', '/inventory', '/sales', '/receivables', '/profitability', '/reports/profit-loss', '/reports/balance-sheet', '/items', '/customers', '/settings/company', '/onboarding', '/reports'];
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
let total = 0;
async function scan(path) {
  await p.goto(base + path, { waitUntil: 'networkidle' });
  await p.evaluate(axeSrc);
  const r = await p.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }));
  for (const v of r.violations) { total++; console.log(`${path}  [${v.impact}] ${v.id} ×${v.nodes.length}: ${v.nodes[0].target.join(' ')} — ${v.help}`); }
}
await scan('/login');
await p.getByRole('button', { name: 'Explore the demo' }).click(); await p.waitForURL('**/dashboard');
for (const path of paths.slice(1)) await scan(path);
console.log(total ? `${total} violation groups` : 'No axe violations');
await b.close();
