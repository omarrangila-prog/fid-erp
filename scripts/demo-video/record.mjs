// Records the demo walkthrough as one clip per scene (webm), against a running demo server.
//   node scripts/demo-video/record.mjs <outDir> [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const BASE = process.argv[3] ?? 'http://localhost:3399';
mkdirSync(OUT, { recursive: true });
const W = 1920;
const H = 1080;
const browser = await chromium.launch();

// A soft ring that follows the pointer so viewers can follow the clicks.
const CURSOR = `
(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:2147483647;left:-50px;top:-50px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(197,160,90,.30);border:2px solid #c5a05a;pointer-events:none;transition:transform .08s,background .12s;box-shadow:0 0 0 6px rgba(197,160,90,.14)';
  const add = () => document.body && document.body.appendChild(d);
  document.body ? add() : document.addEventListener('DOMContentLoaded', add);
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(.7)'; d.style.background = 'rgba(197,160,90,.65)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; d.style.background = 'rgba(197,160,90,.30)'; }, true);
})();`;

let ctx;
let page;
let scene = '';
let state;

async function begin(name, { mobile = false, session = true } = {}) {
  scene = name;
  ctx = await browser.newContext({
    viewport: mobile ? { width: 430, height: 932 } : { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: join(OUT, '_raw'), size: mobile ? { width: 430, height: 932 } : { width: W, height: H } },
    ...(session && state ? { storageState: state } : {}),
  });
  await ctx.addInitScript(CURSOR);
  page = await ctx.newPage();
}
async function end() {
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), join(OUT, `${scene}.webm`));
}
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
  const steps = Math.round(ms / 16);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.evaluate((y) => window.scrollTo(0, y), y0 + (y1 - y0) * e);
    await page.waitForTimeout(16);
  }
}
async function go(path, settle = 1800) {
  await page.goto(BASE + path);
  await wait(settle);
}
async function attempt(fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[${scene}] skipped step: ${String(e).split('\n')[0]}`);
  }
}
const firstRow = () => page.locator('tbody tr').first();

// Sign in once, keep the session for every scene.
{
  const c = await browser.newContext({ viewport: { width: W, height: H } });
  const p = await c.newPage();
  await p.goto(BASE + '/login');
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Explore the demo' }).click();
  await p.waitForURL('**/dashboard', { timeout: 30000 });
  state = await c.storageState();
  await c.close();
}

await begin('01-login', { session: false });
await go('/login', 2600);
await attempt(() => click(page.getByRole('button', { name: 'Explore the demo' }), 1100));
await page.waitForURL('**/dashboard', { timeout: 30000 });
await wait(2600);
await end();

await begin('02-dashboard');
await go('/dashboard', 2200);
await attempt(() => glide(page.getByText('Customer Receivables').first(), 900));
await wait(1200);
await drift(0, 760, 2800);
await wait(1400);
await drift(760, 0, 1800);
await end();

await begin('03-purchase');
await go('/purchases', 1800);
await attempt(async () => { await click(firstRow(), 900); await page.waitForLoadState('networkidle'); });
await wait(2200);
await drift(0, 900, 3200);
await wait(1500);
await end();

await begin('04-shipments');
await go('/shipments', 1800);
await attempt(async () => { await click(page.locator('tbody tr').first().getByRole('button').first(), 900); });
await wait(1800);
await attempt(async () => { await click(page.getByRole('link', { name: 'Costing' }).first(), 900); await page.waitForLoadState('networkidle'); });
await wait(2200);
await drift(0, 1100, 3600);
await wait(1200);
await end();

await begin('05-stock');
await go('/inventory', 2200);
await drift(0, 640, 2600);
await wait(1800);
await end();

await begin('06-invoice');
await go('/sales', 1800);
await attempt(async () => { await click(page.getByRole('link', { name: 'View' }).first(), 900); await page.waitForLoadState('networkidle'); });
await wait(2000);
await drift(0, 560, 2000);
await wait(1200);
await end();

await begin('07-receivables');
await go('/receivables', 2200);
await drift(0, 380, 2000);
await wait(1800);
await end();

await begin('08-profit');
await go('/profitability', 2400);
await drift(0, 520, 2600);
await wait(1800);
await end();

await begin('09-reports');
await go('/reports/profit-loss', 2200);
await drift(0, 480, 2200);
await go('/reports/balance-sheet', 2200);
await drift(0, 420, 2000);
await wait(1200);
await end();

await begin('10-multicompany');
await go('/dashboard', 1600);
await attempt(async () => { await click(page.getByText('Global Trading Demo LLC').first(), 800); await wait(900); });
await attempt(async () => { await click(page.getByText('Threadline Apparel', { exact: false }).first(), 700); await wait(2800); });
await go('/sales', 2000);
await drift(0, 480, 2200);
await end();

await begin('11-settings');
await go('/settings/company', 2200);
await drift(0, 900, 3000);
await wait(1200);
await end();

await begin('12-mobile', { mobile: true });
await go('/dashboard', 2400);
await drift(0, 620, 2600);
await go('/inventory', 2200);
await drift(0, 360, 1800);
await end();

await browser.close();
console.log(readdirSync(OUT).filter((f) => f.endsWith('.webm')).join('\n'));
