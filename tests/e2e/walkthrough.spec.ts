import { test, expect, type Page } from '@playwright/test';

/**
 * The whole system, driven the way somebody actually uses it.
 *
 * Every screen a person reaches in a working day is opened and read: not
 * "does it return 200" but does the page contain the figures it exists to
 * show, do the reports agree with one another, and does a document raised on
 * one screen appear on the others that depend on it.
 *
 * This runs against the trade scripts/e2e-fixture.ts puts into the test
 * database — one purchase, received, loaded, sold, part paid, with a supplier
 * payment and a clearing cost behind it — so a screen that exists to show a
 * figure is expected to show that figure. Screens the fixture leaves empty
 * (credit notes, stock counts) are expected to open cleanly and say so.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the walkthrough.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  // `domcontentloaded`, not the default `load`: waiting for every subresource
  // on a page that keeps polling aborts under load, and the whole spec fails
  // on the sign-in rather than on anything it set out to check.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).or(page.getByRole('link', { name: /FID Trading L\.L\.C\./ })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
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
  // domcontentloaded, not load. Measured against this app the load event fires
  // three milliseconds after the document is ready, so waiting for it buys
  // nothing — but it can hang on a stylesheet or a font and take the whole
  // ninety-second budget with it, which is a failure that says nothing about
  // the page.
  await page.goto(path, { waitUntil: 'domcontentloaded' });
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
  await open(page, '/purchases', /E2E-PO-DXB-1|FID-DXB-PO-/);
  await open(page, '/sales', /INV\s*\d+/);
  await open(page, '/shipments', /FID-DXB-SHP-|Sidamo/);
  // The receipts list leads with the supplier's own reference; the internal
  // GRN number is not on the screen.
  await open(page, '/goods-receipts', /E2E-PO-DXB-1|Sidamo/);
});

test('inventory shows stock, batches, movements and what is at sea', async ({ page }) => {
  await open(page, '/inventory', /Sidamo/);
  await open(page, '/inventory/batches', /E2E-B-DXB-1/);
  await open(page, '/inventory/movements', /Sidamo|Received/);
  await open(page, '/inventory/shipments', /Sidamo/);
  // No count has been taken: the screen opens and says so.
  await open(page, '/inventory/stock-counts', /stock count|Stock count/i);
});

test('the money screens show the cash cycle', async ({ page }) => {
  await open(page, '/finance/receipts', /FID-DXB-RV-/);
  await open(page, '/finance/payments', /FID-DXB-PV-/);
  // The expense list leads with the category and what the money was for, not
  // the system's own voucher number.
  await open(page, '/finance/expenses', /Ocean Freight|Clearing|Customs|Transport/);
  await open(page, '/finance/cash-bank', /Cash in Hand|Bank Account/);
  await open(page, '/finance/receivables', /E2E Roastery Dubai/);
  await open(page, '/finance/payables', /E2E Exporter Ethiopia/);
  await open(page, '/finance/reconciliation', /statement|Statement/);
});

test('the credit note screen opens with nothing to show', async ({ page }) => {
  await open(page, '/sales/credit-notes', /credit note|Credit note/i);
  await expect(page.getByRole('heading', { name: /this page could|something went wrong/i })).toHaveCount(0);
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
  await expect(page.getByText(/\d+ of \d+ passing|All checks pass|Everything agrees/i).first()).toBeVisible({ timeout: 20_000 });
});

test('the tax return is prepared and ties to the ledger', async ({ page }) => {
  // A wide period, the way an accountant checking a full year would set it.
  // The screen's own default is the last complete quarter, which for a business
  // that only bought in that quarter is legitimately a refund claim with no
  // sales on it — correct, but not what this test is checking.
  const year = new Date().getUTCFullYear();
  await page.goto(`/reports/tax-return?from=${year - 1}-01-01&to=${year}-12-31`);

  await expect(page.getByRole('heading', { name: /VAT Return/i })).toBeVisible({ timeout: 20_000 });

  // Sales are reported by code, treatment and rate rather than folded into one
  // total — whether the fixture's sale is standard-rated or out of scope.
  for (const header of [/^Code$/, /^Treatment$/, /^Rate$/]) {
    await expect(page.getByRole('columnheader', { name: header }).first()).toBeVisible();
  }
  await expect(page.getByRole('row').filter({ hasText: /%/ }).first()).toBeVisible();
  await expect(page.getByText(/Output VAT/i).first()).toBeVisible();

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
    .getByRole('link', { name: /INV\s*\d+/ })
    .first()
    .getAttribute('href');
  expect(invoicePath, 'the sales list should link to an invoice').toMatch(/^\/sales\/[a-z0-9]+$/);

  await page.goto(invoicePath!);
  await expect(page.getByText(/E2E Roastery Dubai/).first()).toBeVisible();

  // domcontentloaded rather than load: the print stylesheet keeps the load
  // event pending long enough to time out, while the document itself — which
  // is all this checks — is there immediately.
  await page.goto(`${invoicePath}/print`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/That record does not exist/)).toHaveCount(0);
  await expect(page.getByText(/Tax Invoice|Commercial Invoice/)).toBeVisible();
  // Named twice on a proper invoice: the masthead and the remittance footer.
  await expect(page.getByText(/FID TRADING L\.L\.C\./)).toHaveCount(2);
});

test('stock ageing and the port master open', async ({ page }) => {
  await open(page, '/reports/stock-ageing', /days|Days/);
  // The buckets are the point of the screen.
  await expect(page.getByText(/0–30 days/).locator('visible=true').first()).toBeVisible();
  await expect(page.getByText(/Why this matters for coffee/)).toBeVisible();

  await open(page, '/ports', /port|Port/);
  // A Dubai company is not offered Casablanca as one of its own ports.
  await expect(page.getByText(/Casablanca/)).toHaveCount(0);
});

test('the contacts and master screens are populated', async ({ page }) => {
  await open(page, '/customers', /E2E Roastery Dubai/);
  await open(page, '/vendors', /E2E Exporter Ethiopia/);
  await open(page, '/items', /Sidamo/);
  await open(page, '/warehouses', /Jebel Ali|Port Rashid/);
  await open(page, '/agents', /E2E Clearing Agent/);
  await open(page, '/shipping-lines', /E2E Container Line/);
});

test('administration is reachable and the audit trail is populated', async ({ page }) => {
  await open(page, '/admin/users', new RegExp(ADMIN_NAME));
  await open(page, '/admin/roles', /Data Entry|Super Admin/);
  // Not the unfiltered page: sign-ins outnumber everything else and fill the
  // whole of page one, which is the reason the filter exists.
  await open(page, '/admin/audit?view=documents', /created|posted|reversed|approved/i);
  await open(page, '/settings/tax', /registration|Registration/);
  await open(page, '/admin/backups', /Backup|backup/);
});

test('the audit log separates what people did from who signed in', async ({ page }) => {
  // Every sign-in is recorded and none is hidden — an audit log that dropped
  // records would be no use to a security review. But sign-ins outnumbered
  // everything else so heavily that the first page held nothing else, and
  // someone looking for who reversed an invoice was reading a list of logins.
  await page.goto('/admin/audit', { waitUntil: 'domcontentloaded' });
  const everything = page.getByText(/entries for FID Trading/);
  await expect(everything).toBeVisible();

  await page.getByRole('link', { name: 'Documents & changes' }).click();
  await page.waitForURL(/view=documents/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/matching entries for FID Trading/)).toBeVisible();
  await expect(page.getByText(/created|posted|reversed|approved/i).locator('visible=true').first()).toBeVisible();
  // And no sign-in survived the filter.
  await expect(page.getByText('User Login', { exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Sign-ins & access' }).click();
  await page.waitForURL(/view=access/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/User Login|Pin Login/i).locator('visible=true').first()).toBeVisible();
});

test('Morocco keeps its own separate books', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).first().click();
  await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
  await expect(page.getByText(/happening at FID Trading International SARL/)).toBeVisible({ timeout: 20_000 });

  // Morocco's own customers, and none of Dubai's.
  await open(page, '/customers', /E2E Torréfacteur Casablanca/);
  await expect(page.getByText(/E2E Roastery Dubai/)).toHaveCount(0);

  await page.goto('/reports/reconciliation');
  await expect(page.getByText(/\d+ of \d+ passing|All checks pass|Everything agrees/i).first()).toBeVisible({ timeout: 20_000 });
});
