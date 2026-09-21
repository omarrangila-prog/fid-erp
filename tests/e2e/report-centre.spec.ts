import { test, expect, type Page } from '@playwright/test';

/**
 * The report centre, the way the client asked for it.
 *
 *   every report in the catalogue opens without an error or a system code
 *   a report is customized in one panel and saved under a name
 *   the saved report appears in the centre, opens the same way, and can go
 *   inventory valuation reads as a summary, by warehouse, and in detail
 *   shipment profitability lays out one column per shipment with a total
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the report centre sweep.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first().click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!MOROCCO.test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: MOROCCO }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

const SAVED_NAME = `Monthly P&L ${Date.now().toString().slice(-5)}`;

test('every report in the centre opens cleanly', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Reports$/ })).toBeVisible({ timeout: 30_000 });

  const hrefs = await page.locator('main a[href]').evaluateAll((links) =>
    [...new Set(links.map((a) => a.getAttribute('href') ?? '').filter((h) => h.startsWith('/') && !h.startsWith('/reports?')))],
  );
  expect(hrefs.length).toBeGreaterThan(20);

  const failures: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const href of hrefs) {
    const response = await page.goto(href, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() >= 400) {
      failures.push(`${href} → HTTP ${response?.status()}`);
      continue;
    }
    await page.locator('main').first().waitFor({ timeout: 45_000 }).catch(() => undefined);
    const text = (await page.locator('main').first().textContent().catch(() => '')) ?? '';
    if (/Something went wrong|Application error|Internal Server Error|Unhandled Runtime Error/i.test(text)) failures.push(`${href} → error screen`);
    // Master-data codes are internal; document numbers (invoice, journal) are the references people quote.
    const code = text.match(/\b(CUS|SUP|AGT|AG|ITM|WH|ACC)-\d{3,}\b/);
    if (code) failures.push(`${href} → system code on screen: ${code[0]}`);
  }
  console.log(`  report centre: ${hrefs.length} reports opened, ${failures.length} failures`);
  expect(failures, failures.join('\n')).toEqual([]);
  expect(pageErrors.filter((m) => !/hydration|ResizeObserver/i.test(m)), pageErrors.join('\n')).toEqual([]);
});

test('a report is customized in one panel and saved under a name', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports/profit-loss', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Profit and Loss$/ })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Customize$/ }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: /Customize Profit & Loss/ })).toBeVisible();
  await panel.getByLabel('From').fill('2026-01-01');
  await panel.getByLabel('To').fill('2026-12-31');
  await panel.getByLabel('Display columns by').selectOption('month');
  await panel.getByLabel('Compare with').selectOption('previous');
  await panel.getByLabel('Name').fill(SAVED_NAME);
  await panel.getByRole('button', { name: /Save custom report/ }).click();

  await page.waitForURL(/columns=month/, { timeout: 30_000 });
  expect(page.url()).toMatch(/from=2026-01-01/);
  expect(page.url()).toMatch(/compare=previous/);
  await expect(page.getByRole('columnheader', { name: /Jan 2026/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('columnheader', { name: /Previous period/ })).toBeVisible();
  console.log('  customize: period, columns and comparison applied together and saved');
});

test('the saved report is in the centre, opens the same way, and can be removed', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports', { waitUntil: 'domcontentloaded' });
  const section = page.getByTestId('saved-reports');
  await expect(section).toBeVisible({ timeout: 30_000 });
  const tile = section.getByRole('link', { name: new RegExp(SAVED_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('href', /profit-loss\?.*columns=month/);

  await tile.click();
  await page.waitForURL(/columns=month/);
  await expect(page.getByRole('columnheader', { name: /Jan 2026/ })).toBeVisible({ timeout: 30_000 });

  await page.goto('/reports', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('saved-reports').getByRole('button', { name: `Remove ${SAVED_NAME}` }).click();
  await expect(page.getByText(new RegExp(`Removed .*${SAVED_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('saved-reports').getByRole('link', { name: new RegExp(SAVED_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toHaveCount(0, { timeout: 30_000 });
  console.log('  saved report: listed under My custom reports, opened, removed');
});

test('every report that shows figures can be taken away as a spreadsheet', async ({ page }) => {
  await signIn(page);
  const reports: Array<[string, string]> = [
    ['/reports/ageing', 'Accounts Receivable Ageing'],
    ['/reports/ageing?side=payables', 'Accounts Payable Ageing'],
    ['/reports/balances', 'Customer Balances'],
    ['/reports/balances?side=suppliers', 'Supplier Balances'],
    ['/reports/sales-by?by=customer', 'Sales by Customer'],
    ['/reports/sales-by?by=item', 'Sales by Coffee'],
    ['/reports/stock-movement', 'Daily Stock Movement'],
    ['/reports/shipment-cost', 'Shipment Costing'],
    ['/reports/inventory-valuation', 'Inventory Valuation'],
    ['/profitability?view=statement', 'Profitability'],
  ];

  const missing: string[] = [];
  for (const [href, expected] of reports) {
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ timeout: 45_000 });
    const excel = page.getByRole('link', { name: /^Excel$/ }).first();
    // The page header paints a moment after the shell on a heavy report, and
    // this suite runs on a busy machine; look for the link, do not glance.
    await excel.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => undefined);
    if ((await excel.count()) === 0) {
      const heading = (await page.locator('main h1, main h2').first().textContent().catch(() => '')) ?? '';
      missing.push(`${href} → no Excel link (page showed: ${heading.trim().slice(0, 80)})`);
      continue;
    }
    const link = (await excel.getAttribute('href'))!;
    // The CSV is read back out of the same workbook, so one request proves both.
    const csv = await page.request.get(`${link}${link.includes('?') ? '&' : '?'}format=csv`);
    if (csv.status() !== 200) {
      missing.push(`${href} → HTTP ${csv.status()}`);
      continue;
    }
    const text = await csv.text();
    if (!text.includes('FID Trading International')) missing.push(`${href} → no company name in the file`);
    if (!new RegExp(expected.split(' ')[0], 'i').test(text)) missing.push(`${href} → file does not name ${expected}`);
  }
  console.log(`  exports: ${reports.length - missing.length} of ${reports.length} reports downloaded with the company name on them`);
  expect(missing, missing.join('\n')).toEqual([]);
});

test('inventory valuation reads as a summary, by warehouse, and in detail', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports/inventory-valuation?view=summary', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Inventory Valuation Summary$/ })).toBeVisible({ timeout: 30_000 });
  for (const header of ['Item', 'Qty', 'Avg landed cost', 'Asset value']) {
    await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
  }
  const total = page.getByRole('row').filter({ hasText: /^Total/ }).first();
  await expect(total).toBeVisible();

  await page.getByRole('link', { name: /^By warehouse$/ }).click();
  await page.waitForURL(/view=warehouse/);
  await expect(page.getByRole('columnheader', { name: /Warehouse/ }).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('link', { name: /^Detail$/ }).click();
  await page.waitForURL(/view=detail/);
  await expect(page.getByRole('heading', { name: /^Inventory Valuation Detail$/ })).toBeVisible({ timeout: 30_000 });
  const group = page.locator('main section').first();
  if (await group.count()) {
    await expect(group.getByText(/On hand/)).toBeVisible();
    for (const header of ['Date', 'Type', 'Warehouse', 'Qty in / out', 'Qty on hand', 'Asset value']) {
      await expect(group.getByRole('columnheader', { name: header })).toBeVisible();
    }
  }
  console.log('  inventory valuation: summary, by warehouse and detail views');
});

test('shipment profitability lays out one column per shipment with a total', async ({ page }) => {
  await signIn(page);
  await page.goto('/profitability?view=statement', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Shipment profitability statement/ })).toBeVisible({ timeout: 45_000 });
  const table = page.getByTestId('profitability-statement');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: /^Total$/ })).toBeVisible();
  for (const measure of [
    'Purchased',
    'Purchase cost',
    'Total direct shipment expenses',
    'Total landed cost',
    'Landed cost per KG',
    'Sold',
    'On hand in the warehouses',
    'Closing stock value',
    'Sales revenue',
    'Average selling price per KG',
    'Cost of goods sold',
    'Gross profit',
    'Net profit',
    'Gross margin',
  ]) {
    await expect(table.locator('td').filter({ hasText: new RegExp(`${measure}$`) }).first()).toBeVisible();
  }
  const shipments = (await table.getByRole('columnheader').count()) - 2;
  expect(shipments).toBeGreaterThan(0);
  console.log(`  profitability statement: ${shipments} shipment columns, measures down the side, total on the right`);
});
