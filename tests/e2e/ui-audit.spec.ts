import { test, expect, type Page } from '@playwright/test';

/**
 * §43 — what does each screen actually show?
 *
 * Opens every screen in the sidebar and writes down the headings of its main
 * table, the summary figures above it and the row actions on offer. The point
 * is not to pass: it is to produce the list this brief has to be checked
 * against, because "the customer table should show outstanding" is only
 * answerable once you know what the customer table shows.
 *
 * Read-only. It opens pages and reads them.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the audit.');

const SCREENS = [
  '/dashboard',
  '/sales',
  '/customers',
  '/finance/receipts',
  '/sales/credit-notes',
  '/purchases',
  '/vendors',
  '/goods-receipts',
  '/finance/payments',
  '/loading',
  '/shipments',
  '/reports/shipment-cost',
  '/inventory',
  '/items',
  '/warehouses',
  '/inventory/batches',
  '/inventory/transfers',
  '/finance/expenses',
  '/finance/cash-bank',
  '/finance/cheques',
  '/accounting/chart',
  '/accounting/journal/new',
  '/reports/general-ledger',
  '/ledgers/customers',
  '/ledgers/vendors',
  '/ledgers/agents',
  '/agents',
  '/finance/receivables',
  '/finance/payables',
  '/reports',
];

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first().click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: /FID Trading/ }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

test('what every screen shows', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await signIn(page);

  for (const path of SCREENS) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    const headers = await page.locator('main table thead th').allTextContents();
    const actions = await page
      .locator('main table tbody tr')
      .first()
      .getByRole('button')
      .or(page.locator('main table tbody tr').first().getByRole('link'))
      .allTextContents();

    // The summary figures above the table, if any.
    const summaryLabels = await page
      .locator('main')
      .locator('p.text-xs, p.text-\\[11px\\]')
      .allTextContents();

    console.log(`\n${path}`);
    console.log(`  columns: ${headers.map((h) => h.trim()).filter(Boolean).join(' | ') || '(no table)'}`);
    if (actions.length) {
      console.log(`  row offers: ${[...new Set(actions.map((a) => a.trim()).filter(Boolean))].slice(0, 10).join(' | ')}`);
    }
    const summary = [...new Set(summaryLabels.map((l) => l.trim()))].filter((l) => l && l.length < 34).slice(0, 6);
    if (summary.length) console.log(`  above it:  ${summary.join(' | ')}`);
  }

  expect(true).toBe(true);
});

test('a remembered table setting survives a reload without a hydration error', async ({ page }) => {
  await signIn(page);

  // Anything React reports on the page: a hydration mismatch arrives here as
  // a pageerror in production, with only a minified number to go on.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/inventory/batches', { waitUntil: 'domcontentloaded' });
  const compact = page.getByRole('button', { name: /Show compact rows/i }).first();
  await expect(compact).toBeVisible({ timeout: 30_000 });
  await compact.click();
  await expect(page.getByRole('button', { name: /Show comfortable rows/i }).first()).toBeVisible();

  // Hide a column as well: that changes the table's shape, which is the kind
  // of difference hydration cannot paper over.
  await page.getByRole('button', { name: /^Columns$/ }).first().click();
  const firstColumn = page.getByRole('dialog').getByRole('checkbox').first();
  const columnLabel = ((await firstColumn.locator('..').textContent()) ?? '').trim();
  const wasShown = await firstColumn.isChecked();
  await firstColumn.click();
  await page.keyboard.press('Escape');
  const header = page.locator('main table thead').first();
  if (wasShown) await expect(header).not.toContainText(columnLabel);
  console.log(`  ${wasShown ? 'hid' : 'showed'} the "${columnLabel}" column, then reloaded`);

  // Come back: the settings are remembered, and applying them did not make
  // the client's first render disagree with the server's HTML.
  await page.goto('/inventory/batches', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /Show comfortable rows/i }).first()).toBeVisible({ timeout: 30_000 });
  if (wasShown) await expect(page.locator('main table thead').first()).not.toContainText(columnLabel);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

  const hydration = errors.filter((e) => /#418|#423|#425|hydrat/i.test(e));
  expect(hydration, hydration.join('\n')).toEqual([]);
});
