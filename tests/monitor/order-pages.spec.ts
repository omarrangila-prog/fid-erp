import { test, expect, type Page } from '@playwright/test';

/**
 * The purchase orders as the client sees them right now. Read-only: it
 * opens the list and each order, records what the shipments card says and
 * takes a screenshot of each, so "the third one shows nothing" can be looked
 * at rather than guessed at.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    const arrived = await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (arrived) break;
    if (!(await tile.isVisible().catch(() => false))) break;
  }
  await expect(keypad).toBeVisible({ timeout: 30_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!new RegExp(COMPANY, 'i').test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: new RegExp(COMPANY, 'i') }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

test('what each purchase order shows', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.screenshot({ path: 'test-results/live-purchases.png', fullPage: true });
  const links = await page.locator('main table tbody tr a[href^="/purchases/"]').evaluateAll((as) =>
    [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''))].filter((h) => /^\/purchases\/[\w-]+$/.test(h)),
  );
  console.log(`  purchase list links: ${links.join(' | ')}`);

  for (const [index, href] of links.entries()) {
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await page.screenshot({ path: `test-results/live-order-${index + 1}.png`, fullPage: true });
    const main = ((await page.locator('main').textContent()) ?? '').replace(/\s+/g, ' ');
    const card = main.match(/(\d+) shipments? on this order.{0,400}/);
    console.log(`\n  order ${index + 1} (${href}):`);
    console.log(`    title: ${(await page.locator('main h1').first().textContent())?.trim()}`);
    console.log(`    shipments card: ${card ? card[0].slice(0, 400) : 'NOT PRESENT'}`);
    console.log(`    order status: ${main.match(/Order status.{0,260}/)?.[0] ?? 'NOT PRESENT'}`);
    console.log(`    receipts: ${main.match(/Goods receipts.{0,160}/)?.[0] ?? '—'}`);
  }

  console.log(`\n  page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
});
