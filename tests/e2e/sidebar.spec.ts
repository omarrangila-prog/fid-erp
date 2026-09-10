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
  await page.goto('/login');
  await page.getByRole('button', { name: /ali raza/i }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./i }).first().click();
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

  test('remembers which groups were left open', async ({ page }) => {
    const finance = page.getByRole('button', { name: /^Finance\b/ });
    await finance.click();
    await expect(page.getByRole('link', { name: 'Receipts', exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: 'Receipts', exact: true })).toBeVisible();
  });

  test('every new screen is reachable from the navigation', async ({ page }) => {
    for (const [group, label, href] of [
      ['Trading', 'Credit Notes', '/sales/credit-notes'],
      ['Trading', 'Supplier Debit Notes', '/purchases/debit-notes'],
      ['Inventory', 'Stock Counts', '/inventory/stock-counts'],
      ['Finance', 'Bank Reconciliation', '/finance/reconciliation'],
      ['Accounting', 'Tax Return', '/reports/tax-return'],
      ['Administration', 'Backups', '/admin/backups'],
      ['Administration', 'Tax Settings', '/settings/tax'],
    ] as const) {
      const heading = page.getByRole('button', { name: new RegExp(`^${group}\\b`) });
      if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();

      const link = page.getByRole('link', { name: label, exact: true });
      await expect(link, `${label} should be in the ${group} group`).toBeVisible();
      await expect(link).toHaveAttribute('href', href);
    }
  });
});
