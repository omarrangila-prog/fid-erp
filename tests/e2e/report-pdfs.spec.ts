import { test, type Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD, PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS } from './credentials';
import { settle } from './settle';

test.skip(!PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS);

/**
 * Not an assertion suite: the Morocco reports as Print / Save as PDF makes
 * them, so the paper version can be looked at. Writes to REPORT_PDF_DIR.
 */
const DIR = process.env.REPORT_PDF_DIR ?? 'test-results/report-pdfs';

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

const REPORTS: Array<[string, string]> = [
  ['/reports/profit-loss', 'profit-loss'],
  ['/reports/balance-sheet', 'balance-sheet'],
  ['/reports/trial-balance', 'trial-balance'],
  ['/profitability', 'shipment-profitability'],
  ['/reports/cogs', 'cogs'],
  ['/inventory', 'stock-on-hand'],
  ['/reports/ageing', 'ar-ageing'],
  ['/reports/general-ledger', 'general-ledger'],
  ['/reports/inventory-valuation', 'inventory-valuation'],
  ['/reports/cash-book', 'cash-book'],
];

test('Morocco reports as PDF', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInMorocco(page);
  const only = process.env.REPORT_PDF_ONLY?.split(',');
  for (const [path, name] of REPORTS) {
    if (only && !only.includes(name)) continue;
    await open(page, path);
    await settle(page);
    // As the Print / PDF button does: fit the sheet's width.
    await page.evaluate(() => document.documentElement.setAttribute('data-print-scale', 'fit'));
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: `${DIR}/${name}.pdf`, preferCSSPageSize: true, printBackground: true });
    await page.emulateMedia({ media: 'screen' });
  }
});
