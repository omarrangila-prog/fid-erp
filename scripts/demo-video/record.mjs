// Records the demo walkthrough as one clip per scene (webm), against a running demo server.
//   node scripts/demo-video/record.mjs <outDir> [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const BASE = process.argv[3] ?? 'http://localhost:3399';
mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080;
const browser = await chromium.launch();

const CURSOR = `
(() => {
  const d = document.createElement('div');
  d.id = '__cursor';
  d.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(236,127,43,.28);border:2px solid #ec7f2b;pointer-events:none;transition:transform .08s,background .12s;box-shadow:0 0 0 6px rgba(236,127,43,.12)';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(d));
  if (document.body) document.body.appendChild(d);
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(.7)'; d.style.background = 'rgba(236,127,43,.6)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; d.style.background = 'rgba(236,127,43,.28)'; }, true);
})();`;

let ctx, page, scene = '';
async function begin(name, { mobile = false, session = true } = {}) {
  scene = name;
  const viewport = mobile ? { width: 430, height: 932 } : { width: W, height: H };
  ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    recordVideo: { dir: join(OUT, '_raw'), size: mobile ? { width: 860, height: 1864 } : { width: W, height: H } },
    ...(session && state ? { storageState: state } : {}),
  });
  await ctx.addInitScript(CURSOR);
  page = await ctx.newPage();
}
async function end() {
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  renameSync(path, join(OUT, `${scene}.webm`));
}
let state;
const wait = (ms) => page.waitForTimeout(ms);
async function glide(target, ms = 700) {
  const box = await target.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: Math.round(ms / 16) });
}
async function click(target, ms = 700) {
  await glide(target, ms);
  await wait(150);
  await target.click();
}
async function drift(y0, y1, ms) {
  // slow, eased scroll
  const steps = Math.round(ms / 16);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.evaluate((y) => window.scrollTo(0, y), y0 + (y1 - y0) * e);
    await page.waitForTimeout(16);
  }
}
async function go(path, settle = 1800) {
  await page.goto(BASE + path);
  await wait(settle);
}
async function attempt(fn) {
  try { await fn(); } catch (e) { console.error(`[${scene}] skipped step: ${String(e).split('\n')[0]}`); }
}

// ---- sign in once, keep the session for every scene ----
{
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  const p = await c.newPage();
  await p.goto(BASE + '/login'); await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Explore the demo' }).click();
  await p.waitForURL('**/dashboard', { timeout: 30000 });
  state = await c.storageState();
  await c.close();
}

// 01 sign-in
await begin('01-login', { session: false });
await go('/login', 2600);
await attempt(async () => click(page.getByRole('button', { name: 'Explore the demo' }), 1100));
await page.waitForURL('**/dashboard', { timeout: 30000 });
await wait(2600);
await end();

// 02 dashboard
await begin('02-dashboard');
await go('/dashboard', 2200);
await attempt(async () => glide(page.getByText('Customer Receivables').first(), 900));
await wait(1200);
await drift(0, 760, 2800);
await wait(1400);
await drift(760, 0, 1800);
await end();

// 03 purchase order and landed cost
await begin('03-purchase');
await go('/purchases', 1800);
await attempt(async () => { const row = page.locator('tbody tr').first(); await click(row, 900); await page.waitForLoadState('networkidle'); });
await wait(2200);
await drift(0, 900, 3200);
await wait(1500);
await end();

// 04 shipment tracking and costing
await begin('04-shipments');
await go('/shipments', 1800);
await attempt(async () => { const row = page.locator('tbody tr').first(); await click(row, 900); await page.waitForLoadState('networkidle'); });
await wait(2200);
await drift(0, 1100, 3600);
await wait(1200);
await end();

// 05 stock on hand
await begin('05-stock');
await go('/inventory', 2200);
await attempt(async () => { const row = page.locator('tbody tr').first(); await click(row, 900); });
await wait(1600);
await drift(0, 640, 2600);
await wait(1800);
await end();

// 06 sale and invoice
await begin('06-invoice');
await go('/sales', 1800);
await attempt(async () => { const row = page.locator('tbody tr').first(); await click(row, 900); await page.waitForLoadState('networkidle'); });
await wait(2000);
await drift(0, 560, 2000);
await attempt(async () => { await page.goto(page.url().replace(/\/?$/, '/print')); await wait(2400); });
await drift(0, 360, 2200);
await wait(1200);
await end();

// 07 receivables
await begin('07-receivables');
await go('/finance/receivables', 2200);
await drift(0, 380, 2000);
await wait(1800);
await end();

// 08 profit
await begin('08-profit');
await go('/profitability', 2400);
await drift(0, 520, 2600);
await wait(1800);
await end();

// 09 reports
await begin('09-reports');
await go('/reports/profit-loss', 2200);
await drift(0, 480, 2200);
await go('/reports/balance-sheet', 2200);
await drift(0, 420, 2000);
await wait(1200);
await end();

// 10 another company, another currency
await begin('10-multicompany');
await go('/dashboard', 1600);
await attempt(async () => { await click(page.locator('header button').first(), 800); await wait(900); });
await attempt(async () => { const opt = page.getByText('Threadline Apparel', { exact: false }).first(); await click(opt, 700); await wait(2800); });
await go('/sales', 2000);
await attempt(async () => { const row = page.locator('tbody tr').first(); await click(row, 800); await page.waitForLoadState('networkidle'); });
await wait(2200);
await drift(0, 480, 2200);
await end();

// 11 company profile and settings (branding)
await begin('11-settings');
await go('/settings/company', 2200);
await drift(0, 900, 3000);
await wait(1200);
await end();

// 12 phone
await begin('12-mobile', { mobile: true });
await go('/dashboard', 2400);
await drift(0, 620, 2600);
await go('/inventory', 2200);
await drift(0, 360, 1800);
await end();

await browser.close();
console.log(readdirSync(OUT).filter((f) => f.endsWith('.webm')).join('\n'));
