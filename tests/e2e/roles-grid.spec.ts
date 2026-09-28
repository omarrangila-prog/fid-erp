import { test, expect, type Page } from '@playwright/test';

/**
 * The owner decides what a role may do, page by page, and which pages it sees
 * first.
 *
 * Unticking Ports → View for Data Entry takes Ports out of the staff member's
 * menu and, more to the point, the server refuses the page from a direct
 * link. Ticking it again gives it back. The role's own menu — "My pages" —
 * sits at the top of the sidebar in the order the owner set.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const STAFF_PIN = process.env.DUBAI_STAFF_PIN;
const STAFF_NAME = process.env.DUBAI_STAFF_NAME ?? 'Dubai Staff';

test.skip(!ADMIN_PIN || !STAFF_PIN, 'Set ADMIN_PIN and DUBAI_STAFF_PIN to run this suite.');
test.setTimeout(240_000);

async function pinIn(page: Page, name: string, pin: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of pin.split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
}

async function openDataEntryRole(page: Page) {
  await page.goto('/admin/roles', { waitUntil: 'domcontentloaded' });
  const row = page.locator('main table').first().locator('tbody tr').filter({ hasText: 'DATA_ENTRY' }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  const href = await row.locator('a[href^="/admin/roles/"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  await page.goto(href!, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('role-grid')).toBeVisible({ timeout: 45_000 });
}

async function setPortsView(page: Page, on: boolean) {
  const box = page.getByTestId('grid-row-ports').getByRole('checkbox', { name: 'Ports: view' });
  if ((await box.isChecked()) !== on) await box.click();
  await page.getByTestId('save-role-grid').click();
  await expect(page.getByText('Permissions saved.')).toBeVisible({ timeout: 30_000 });
}

test('unticking a page in the grid is refused on the server; ticking it gives it back', async ({ browser }) => {
  const admin = await browser.newPage();
  const staff = await browser.newPage();
  await pinIn(admin, ADMIN_NAME, ADMIN_PIN!);
  await pinIn(staff, STAFF_NAME, STAFF_PIN!);
  await openDataEntryRole(admin);

  try {
    await setPortsView(admin, false);
    await staff.goto('/ports', { waitUntil: 'domcontentloaded' });
    await expect(staff).toHaveURL(/\/unauthorized/, { timeout: 30_000 });
    await expect(staff.getByRole('link', { name: 'Ports', exact: true })).toHaveCount(0);
  } finally {
    await setPortsView(admin, true);
  }
  await staff.goto('/ports', { waitUntil: 'domcontentloaded' });
  await expect(staff).toHaveURL(/\/ports/, { timeout: 30_000 });
  await expect(staff.getByRole('heading', { level: 1 })).toContainText(/Ports/);
});

test('the role’s own pages come first in the menu, in the owner’s order', async ({ browser }) => {
  const admin = await browser.newPage();
  await pinIn(admin, ADMIN_NAME, ADMIN_PIN!);
  await openDataEntryRole(admin);
  const menu = admin.getByTestId('role-menu');

  // Sales invoices, then Shipments — then Shipments moved to the top.
  const add = menu.getByTestId('role-menu-add');
  await add.selectOption('/sales');
  await add.selectOption('/shipments');
  await menu.getByTestId('role-menu-page').nth(1).getByRole('button', { name: 'Move up' }).click();
  await expect(menu.getByTestId('role-menu-page').first()).toContainText('Shipments');
  await menu.getByTestId('save-role-menu').click();
  await expect(admin.getByText('Menu saved.')).toBeVisible({ timeout: 30_000 });

  try {
    const staff = await browser.newPage();
    await pinIn(staff, STAFF_NAME, STAFF_PIN!);
    const nav = staff.locator('aside nav[aria-label="Main"]');
    const first = nav.locator(':scope > div.pb-1').first();
    await expect(first.getByRole('button').first()).toHaveText(/My pages/, { timeout: 30_000 });
    const links = first.getByRole('link');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveText(/Shipments/);
    await expect(links.nth(1)).toHaveText(/Invoices/);
  } finally {
    // Back to the usual menu for the other suites.
    await admin.reload({ waitUntil: 'domcontentloaded' });
    for (let i = await menu.getByTestId('role-menu-page').count(); i > 0; i -= 1) {
      await menu.getByTestId('role-menu-page').first().getByRole('button', { name: /^Remove/ }).click();
    }
    await menu.getByTestId('save-role-menu').click();
    await expect(admin.getByText('Menu saved.')).toBeVisible({ timeout: 30_000 });
  }
});
