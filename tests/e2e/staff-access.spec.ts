import { test, expect, type Page } from '@playwright/test';

/**
 * What a data-entry operator can actually reach.
 *
 * The permission catalogue is asserted in the integration suite; this asserts
 * the thing that matters to the person paying for it — that a Dubai employee,
 * in a real browser, cannot open Morocco, cannot post anything, and is not
 * shown controls that would only fail if they pressed them.
 */

const DUBAI_PIN = process.env.DUBAI_STAFF_PIN;
const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!DUBAI_PIN || !ADMIN_PIN, 'Set DUBAI_STAFF_PIN and ADMIN_PIN to run the staff-access tests.');

async function pinIn(page: Page, name: string, pin: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
  for (const digit of pin.split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/);
}

test.describe('a Dubai data-entry operator', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await pinIn(page, 'Dubai Staff', DUBAI_PIN!);
  });

  test('lands in Dubai and is never offered Morocco', async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(/FID Trading L\.L\.C\./).first()).toBeVisible();

    // Not a switcher, not a disabled switcher — Morocco is simply not present.
    await expect(page.getByText(/FID Trading International SARL/)).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /International SARL/ })).toHaveCount(0);
  });

  test('is not shown the administrative sections at all', async ({ page }) => {
    // Reports is not listed: a data-entry operator legitimately reaches a
    // couple of operational lists there. Administration and Accounting are the
    // sections that must not exist for them at all.
    for (const label of ['Administration', 'Accounting']) {
      await expect(
        page.getByRole('button', { name: new RegExp(`^${label}\\b`) }),
        `${label} should not appear in the sidebar`,
      ).toHaveCount(0);
    }
  });

  test('is refused every route that posts, administers or reveals margin', async ({ page }) => {
    // Twenty navigations, each ending in a server-side redirect. That is more
    // than the default per-test budget allows for, and the budget running out
    // is not the same finding as a route being reachable.
    test.setTimeout(240_000);

    const forbidden = [
      '/admin/users',
      '/admin/roles',
      '/admin/companies',
      '/admin/audit',
      '/admin/backups',
      '/settings',
      '/settings/tax',
      '/accounting/journal/new',
      '/accounting/revaluation',
      '/reports/profit-loss',
      '/reports/balance-sheet',
      '/reports/trial-balance',
      '/reports/general-ledger',
      '/reports/tax-return',
      '/reports/reconciliation',
      '/profitability',
      '/finance/reconciliation',
      '/ledgers/customers',
      '/inventory/transfers/new',
    ];

    for (const path of forbidden) {
      // A server-side redirect fired mid-navigation surfaces as ERR_ABORTED,
      // which is the guard doing its job rather than a failure. What matters is
      // where the browser ends up, so the navigation error is swallowed and the
      // final URL is what gets asserted.
      await page.goto(path, { waitUntil: 'commit' }).catch(() => undefined);

      // Poll the address rather than assert it once: the guard redirects from
      // the server, so the browser is briefly still on the requested path.
      await expect
        .poll(() => new URL(page.url()).pathname, {
          message: `${path} should not open for a data-entry operator`,
          timeout: 15_000,
        })
        .not.toBe(path);
    }
  });

  test('can still do the job: raising a draft is allowed', async ({ page }) => {
    await page.goto('/customers?new=1');
    await expect(page).toHaveURL(/\/customers/);

    await page.goto('/sales/new');
    await expect(page).toHaveURL(/\/sales\/new/);

    await page.goto('/finance/receipts/new');
    await expect(page).toHaveURL(/\/finance\/receipts\/new/);
  });

  test('cannot post a document it has raised', async ({ page }) => {
    await page.goto('/sales');
    // The post control is gated on SALES_APPROVE, which this role lacks.
    await expect(page.getByRole('button', { name: /^Post$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Approve$/ })).toHaveCount(0);
  });
});

test.describe('the owner', () => {
  test('reaches both companies and every administrative screen', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await pinIn(page, ADMIN_NAME, ADMIN_PIN!);

    for (const path of ['/admin/users', '/settings/tax', '/reports/tax-return', '/admin/backups']) {
      await page.goto(path);
      await expect(page, `${path} should open for the owner`).toHaveURL(new RegExp(path.replace(/\//g, '\\/')));
    }
  });
});
