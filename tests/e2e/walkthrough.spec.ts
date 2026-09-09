import { test, expect, type Page } from '@playwright/test';

/**
 * The whole system, driven the way somebody actually uses it.
 *
 * Every screen a person reaches in a working day is opened and read: not
 * "does it return 200" but does the page contain the figures it exists to
 * show, do the reports agree with one another, and does a document raised on
 * one screen appear on the others that depend on it.
 *
 * This runs against the demonstration data, which is a full book of trade, so
 * an empty page here means a real failure rather than an empty database.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the walkthrough.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/);
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/\/dashboard/);
  }
}

/**
 * Opens a page and fails if it rendered an error boundary or an empty shell.
 *
 * `visible=true` matters: a filter dropdown holds every customer name as an
 * <option>, so a bare text match finds the name in a collapsed select and
 * passes while the table behind it is empty — the exact failure this is meant
 * to catch.
 */
async function open(page: Page, path: string, expected: RegExp) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /this page could|something went wrong/i })).toHaveCount(0);
  await expect(
    page.getByText(expected).locator('visible=true').first(),
    `${path} should show ${expected}`,
  ).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('the dashboard shows a business that is actually trading', async ({ page }) => {
  await page.goto('/dashboard');
  // With real data behind it, the setup checklist must be gone.
  await expect(page.getByText(/Welcome to FID Trading/)).toHaveCount(0);
  await expect(page.getByText(/happening at FID Trading L\.L\.C\./)).toBeVisible();
});

test('trading screens list the consignments', async ({ page }) => {
  await open(page, '/purchases', /DEMO-PO-ETH-2601|FID-DXB-PO-/);
  await open(page, '/sales', /FID-DXB-SI-/);
  await open(page, '/shipments', /FID-DXB-SHP-|Yirgacheffe/);
  await open(page, '/goods-receipts', /FID-DXB-/);
});

test('inventory shows stock, batches, movements and what is at sea', async ({ page }) => {
  await open(page, '/inventory', /Yirgacheffe|Santos/);
  await open(page, '/inventory/batches', /DEMO-B-/);
  await open(page, '/inventory/movements', /Yirgacheffe|Santos|Received/);
  await open(page, '/inventory/shipments', /Supremo|in transit|In Transit/i);
  await open(page, '/inventory/stock-counts', /FID-DXB-SC-/);
});

test('the money screens show the cash cycle', async ({ page }) => {
  await open(page, '/finance/receipts', /FID-DXB-RV-/);
  await open(page, '/finance/payments', /FID-DXB-PV-/);
  await open(page, '/finance/expenses', /FID-DXB-EV-/);
  await open(page, '/finance/cash-bank', /Bank Account|AED/);
  await open(page, '/finance/receivables', /Emirates Specialty|Gulf Coffee|Doha/);
  await open(page, '/finance/payables', /Moplaco|Cooxupé/);
  await open(page, '/finance/reconciliation', /statement|Statement/);
});

test('the credit note and the coffee it returned are both visible', async ({ page }) => {
  await open(page, '/sales/credit-notes', /FID-DXB-CN-/);
  await page.getByRole('link', { name: /FID-DXB-CN-/ }).first().click();
  await expect(page.getByText(/Quality claim/)).toBeVisible();
  await expect(page.getByText(/Returned|returned/).first()).toBeVisible();
});

test('the accounting reports agree with one another', async ({ page }) => {
  await open(page, '/reports/trial-balance', /Coffee Sales|Accounts Receivable/);
  await open(page, '/reports/profit-loss', /Coffee Sales|Cost of Goods Sold/);
  await open(page, '/reports/balance-sheet', /Inventory|Accounts Receivable/);
  await open(page, '/reports/general-ledger', /Account|account/);
  await open(page, '/reports/journal', /FID-DXB-JV-/);
  await open(page, '/reports/cash-flow', /Bank|Cash/);

  // The report that exists to catch everything else being wrong.
  await page.goto('/reports/reconciliation');
  await expect(page.getByText(/10 of 10|All checks pass|Everything agrees/i).first()).toBeVisible({ timeout: 20_000 });
});

test('the tax return is prepared and ties to the ledger', async ({ page }) => {
  // A wide period, the way an accountant checking a full year would set it.
  // The screen's own default is the last complete quarter, which for a business
  // that only bought in that quarter is legitimately a refund claim with no
  // sales on it — correct, but not what this test is checking.
  const year = new Date().getUTCFullYear();
  await page.goto(`/reports/tax-return?from=${year - 1}-01-01&to=${year}-12-31`);

  await expect(page.getByRole('heading', { name: /VAT Return/i })).toBeVisible({ timeout: 20_000 });

  // Zero-rated exports and standard-rated domestic sales are reported on
  // different lines, which is the whole reason the treatments exist.
  await expect(page.getByText(/zero.rated/i).locator('visible=true').first()).toBeVisible();
  await expect(page.getByText(/standard/i).locator('visible=true').first()).toBeVisible();

  // The figures are built from the documents and checked against the VAT
  // control accounts; a difference between the two is reported loudly.
  await expect(page.getByText(/Does not agree with the ledger/i)).toHaveCount(0);
  await expect(page.getByText(/Agrees with the ledger/i).first()).toBeVisible();
});

test('profitability and the analysis sheet report a margin', async ({ page }) => {
  await open(page, '/profitability', /Gross|Margin|margin/);
  await open(page, '/reports/analytics', /Revenue|revenue/);
  await open(page, '/reports/business-overview', /Revenue|Cash|revenue/);
});

test('a document opens and prints', async ({ page }) => {
  await page.goto('/sales');

  // Take the href off the link rather than reading page.url() after a click.
  // The list renders a table and a mobile card layout, so the same invoice
  // appears twice and which one is "first" is not something this test should
  // be deciding — and a URL read after navigation is one race away from being
  // the previous page's.
  const invoicePath = await page
    .getByRole('link', { name: /FID-DXB-SI-\d+/ })
    .first()
    .getAttribute('href');
  expect(invoicePath, 'the sales list should link to an invoice').toMatch(/^\/sales\/[a-z0-9]+$/);

  await page.goto(invoicePath!);
  await expect(page.getByText(/Emirates Specialty|Gulf Coffee|Al Marsa|Doha/).first()).toBeVisible();

  // domcontentloaded rather than load: the print stylesheet keeps the load
  // event pending long enough to time out, while the document itself — which
  // is all this checks — is there immediately.
  await page.goto(`${invoicePath}/print`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/That record does not exist/)).toHaveCount(0);
  await expect(page.getByText(/Tax Invoice|Commercial Invoice/)).toBeVisible();
  // Named twice on a proper invoice: the masthead and the remittance footer.
  await expect(page.getByText(/FID TRADING L\.L\.C\./)).toHaveCount(2);
});

test('the contacts and master screens are populated', async ({ page }) => {
  await open(page, '/customers', /Emirates Specialty/);
  await open(page, '/vendors', /Moplaco/);
  await open(page, '/items', /Yirgacheffe/);
  await open(page, '/warehouses', /Jebel Ali|Port Rashid/);
  await open(page, '/agents', /Levant|Maghreb/);
  await open(page, '/shipping-lines', /Maersk|CMA/);
});

test('administration is reachable and the audit trail is populated', async ({ page }) => {
  await open(page, '/admin/users', new RegExp(ADMIN_NAME));
  await open(page, '/admin/roles', /Data Entry|Super Admin/);
  await open(page, '/admin/audit', /invoice created|count posted|created|posted/i);
  await open(page, '/settings/tax', /registration|Registration/);
  await open(page, '/admin/backups', /Backup|backup/);
});

test('Morocco keeps its own separate books', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).first().click();
  await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
  await expect(page.getByText(/happening at FID Trading International SARL/)).toBeVisible({ timeout: 20_000 });

  // Morocco's own customers, and none of Dubai's.
  await open(page, '/customers', /Torréfaction Casablanca|Café Maghreb|Atlas Coffee/);
  await expect(page.getByText(/Emirates Specialty Roasters/)).toHaveCount(0);

  await page.goto('/reports/reconciliation');
  await expect(page.getByText(/10 of 10|All checks pass|Everything agrees/i).first()).toBeVisible({ timeout: 20_000 });
});
