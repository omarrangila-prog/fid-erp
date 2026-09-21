import { test, expect, type Page } from '@playwright/test';

/**
 * The collapsing sidebar.
 *
 * These exist because the previous version was broken in a way that looked
 * fine in the code: collapsing kept an icon per screen, so the rail grew
 * *taller* than the expanded one, and the hover labels sat inside an
 * `overflow-y-auto` container that clipped them horizontally. You lost the
 * width and got nothing back. Both are measured here rather than eyeballed.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the sidebar tests.');

/**
 * The rail animates its width over 200ms. Measuring before it settles compares
 * a flyout against a rail that is still halfway through moving, which fails for
 * a reason that has nothing to do with the layout.
 */
async function settledRailWidth(page: Page): Promise<number> {
  const rail = page.locator('aside').first();
  let last = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const box = await rail.boundingBox();
    const width = Math.round(box!.width);
    if (width === last) return width;
    last = width;
    await page.waitForTimeout(50);
  }
  return last;
}

async function signIn(page: Page) {
  // `domcontentloaded`, not the default `load`: waiting for every subresource
  // on a page that keeps polling aborts under load, and the whole spec fails
  // on the sign-in rather than on anything it set out to check.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /ali raza/i }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: /FID Trading L\.L\.C\./i }).or(page.getByRole('link', { name: /FID Trading L\.L\.C\./i })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

test.describe('sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
  });

  test('collapsing makes the rail narrower and no taller', async ({ page }) => {
    const expandedWidth = await settledRailWidth(page);
    const expandedNavHeight = await page.locator('aside nav').first().boundingBox();

    await page.getByRole('button', { name: /collapse the sidebar/i }).click();
    await expect(page.getByRole('button', { name: /expand the sidebar/i })).toBeVisible();

    const collapsedWidth = await settledRailWidth(page);
    const collapsedNavHeight = await page.locator('aside nav').first().boundingBox();

    expect(collapsedWidth).toBeLessThan(expandedWidth);
    // The whole point: a collapsed rail must not be taller than the open one.
    expect(collapsedNavHeight!.height).toBeLessThanOrEqual(expandedNavHeight!.height);
  });

  test('a collapsed group opens a flyout that is not clipped by the scroll container', async ({ page }) => {
    await page.getByRole('button', { name: /collapse the sidebar/i }).click();
    await expect(page.getByRole('button', { name: /expand the sidebar/i })).toBeVisible();
    const railWidth = await settledRailWidth(page);

    await page.getByRole('button', { name: /^Inventory — \d+ screens$/ }).click();

    const link = page.getByRole('link', { name: 'Stock on Hand', exact: true });
    await expect(link).toBeVisible();

    // Visible is not enough: a clipped element can still report visible. The
    // flyout has to sit to the right of the rail, outside it.
    const linkBox = await link.boundingBox();
    expect(linkBox!.x).toBeGreaterThanOrEqual(railWidth);
    expect(linkBox!.width).toBeGreaterThan(80);
  });

  test('a section opens and closes, and is remembered', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    const cashBank = nav.getByRole('button', { name: /^Cash & Bank\b/ });
    const cashBook = nav.getByRole('link', { name: 'Cash Book', exact: true });

    await expect(cashBank).toHaveAttribute('aria-expanded', 'false');
    await expect(cashBook).toBeHidden();
    await cashBank.click();
    await expect(cashBank).toHaveAttribute('aria-expanded', 'true');
    await expect(cashBook).toBeVisible();

    await page.reload();
    await expect(nav.getByRole('link', { name: 'Cash Book', exact: true })).toBeVisible();

    await nav.getByRole('button', { name: /^Cash & Bank\b/ }).click();
    await expect(nav.getByRole('link', { name: 'Cash Book', exact: true })).toBeHidden();
    await page.reload();
    await expect(nav.getByRole('link', { name: 'Cash Book', exact: true })).toBeHidden();
  });

  test('the section holding the current page opens by itself', async ({ page }) => {
    await page.goto('/ledgers/customers', { waitUntil: 'domcontentloaded' });
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('button', { name: /^Sales\b/ })).toHaveAttribute('aria-expanded', 'true');
    const link = nav.getByRole('link', { name: 'Customer Ledger', exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('aria-current', 'page');

    // Two links on one page, told apart by their filter.
    await page.goto('/finance/expenses?kind=GENERAL', { waitUntil: 'domcontentloaded' });
    await expect(nav.getByRole('link', { name: 'General Expenses', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('every screen in the menu is one heading click away', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const [group, label, href] of [
      ['Sales', 'Invoices', '/sales'],
      ['Sales', 'Customers', '/customers'],
      ['Sales', 'Customer Ledger', '/ledgers/customers'],
      ['Sales', 'Payments Received', '/finance/receipts'],
      ['Sales', 'Credit Notes', '/sales/credit-notes'],
      ['Purchases', 'Purchase Orders', '/purchases'],
      ['Purchases', 'Suppliers', '/vendors'],
      ['Purchases', 'Supplier Ledger', '/ledgers/vendors'],
      ['Purchases', 'Goods Receipts', '/goods-receipts'],
      ['Shipments', 'Loading Sheet', '/loading'],
      ['Shipments', 'Shipment Costing', '/reports/shipment-cost'],
      ['Inventory', 'Stock on Hand', '/inventory'],
      ['Inventory', 'Warehouse Transfers', '/inventory/transfers'],
      ['Cash & Bank', 'Cash Book', '/reports/cash-book'],
      ['Accounting', 'General Journal', '/reports/journal'],
      ['Accounting', 'General Ledgers', '/ledgers'],
      ['Accounting', 'Chart of Accounts', '/accounting/chart'],
      ['Agents', 'Agents', '/agents'],
      ['Agents', 'Cheques', '/finance/cheques'],
      ['Reports', 'Trial Balance', '/reports/trial-balance'],
      ['Reports', 'All Reports', '/reports'],
      ['Administration', 'Backups', '/admin/backups'],
    ] as const) {
      const heading = nav.getByRole('button', { name: new RegExp(`^${group.replace('&', '\\&')}\\b`) });
      if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
      const link = nav.getByRole('link', { name: label, exact: true });
      await expect(link, `${label} should be visible under ${group}`).toBeVisible();
      await expect(link).toHaveAttribute('href', href);
    }
  });
});
