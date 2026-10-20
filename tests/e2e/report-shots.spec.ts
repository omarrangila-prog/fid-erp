import { test, type Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD, PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS } from './credentials';
import { settle } from './settle';

test.skip(!PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS);

/**
 * Not an assertion suite: the Morocco reports captured so a person can see
 * them. Writes to REPORT_SHOTS_DIR (default test-results/report-shots).
 */
const DIR = process.env.REPORT_SHOTS_DIR ?? 'test-results/report-shots';

/** A load the sign-in redirect may still abort: wait, then load it once more. */
async function open(page: Page, path: string) {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  } catch {
    await page.waitForTimeout(1000);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
}

async function signInMorocco(page: Page) {
  await page.goto('/login/password');
  await page.getByLabel(/email/i).fill(E2E_EMAIL!);
  await page.getByLabel(/password/i).fill(E2E_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|select-company/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: /International SARL/ }).or(page.getByRole('link', { name: /International SARL/ })).first().click();
    await page.waitForURL(/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (!/International SARL/.test((await switcher.textContent()) ?? '')) {
    await switcher.click();
    await page.getByRole('menuitem', { name: /International SARL/ }).click();
    await page.waitForLoadState('domcontentloaded');
  }
}

async function shot(page: Page, path: string, name: string, prepare?: (page: Page) => Promise<void>) {
  await open(page, path);
  await settle(page);
  if (prepare) await prepare(page).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

const REPORTS: Array<[string, string, ((page: Page) => Promise<void>)?]> = [
  ['/reports', '01-report-centre'],
  ['/reports/profit-loss', '02-profit-loss'],
  ['/reports/profit-loss', '03-profit-loss-by-shipment', async (p) => {
    await p.locator('select[name="shipment"]').selectOption({ index: 1 });
    await p.getByRole('button', { name: 'Show' }).click();
    await p.waitForURL(/shipment=/);
    await settle(p);
  }],
  ['/reports/profit-loss', '04-profit-loss-by-customer', async (p) => {
    await p.locator('select[name="customer"]').selectOption({ index: 1 });
    await p.getByRole('button', { name: 'Show' }).click();
    await p.waitForURL(/customer=/);
    await settle(p);
  }],
  ['/reports/balance-sheet', '05-balance-sheet'],
  ['/reports/trial-balance', '06-trial-balance'],
  ['/profitability', '07-shipment-profitability', async (p) => {
    await p.locator('[data-testid="shipment-profitability-row"] summary').first().click();
  }],
  ['/profitability?view=statement', '08-profitability-statement'],
  ['/reports/cogs', '09-cogs'],
  ['/inventory', '10-stock-on-hand'],
  ['/inventory/batches', '11-batch-stock'],
  ['/reports/inventory-valuation', '12-inventory-valuation'],
  ['/reports/ageing', '13-ar-ageing'],
  ['/reports/ageing?side=payables', '14-ap-ageing'],
  ['/reports/cash-book', '15-cash-bank-book'],
  ['/reports/general-ledger', '16-general-ledger'],
  ['/admin/consistency', '17-consistency-checks'],
];

test('Morocco reports, desktop', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInMorocco(page);
  for (const [path, name, prepare] of REPORTS) await shot(page, path, name, prepare);
  // The shipment and item pages, opened from their lists.
  await page.goto('/profitability', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const shipmentHref = await page.locator('a[href^="/shipments/"]').first().getAttribute('href').catch(() => null);
  if (shipmentHref) await shot(page, shipmentHref, '18-shipment-detail');
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  await settle(page);
  const itemHref = await page.locator('a[href^="/inventory/items/"]').first().getAttribute('href').catch(() => null);
  if (itemHref) await shot(page, itemHref, '19-item-detail');
});

test('Morocco reports, phone', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInMorocco(page);
  for (const [path, name] of [
    ['/reports/profit-loss', 'm1-profit-loss'],
    ['/profitability', 'm2-shipment-profitability'],
    ['/inventory', 'm3-stock-on-hand'],
    ['/reports/trial-balance', 'm4-trial-balance'],
  ] as const) await shot(page, path, name);
});
