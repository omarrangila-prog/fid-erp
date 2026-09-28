import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * A shipment page lists the sales invoices that sold its coffee — number,
 * customer, container, kilograms, amount, whether it is paid — and an invoice
 * that has been corrected says so, with when and by whom. The fixture's
 * Moroccan trade sells 12,000 KG of container E2EU2000001 to E2E Torréfacteur
 * Casablanca, part paid.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const CUSTOMER = 'E2E Torréfacteur Casablanca';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.setTimeout(300_000);

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await chooseCompany(page, /FID Trading International SARL/);
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!/International SARL/.test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
      await expect(page.getByRole('button', { name: /International SARL/ })).toBeVisible({ timeout: 30_000 });
    }
  }
}

function invoiceRow(page: Page) {
  return page.getByTestId('shipment-sales-invoices').getByTestId('shipment-sales-invoice').filter({ hasText: CUSTOMER }).first();
}

test('a shipment lists its sales invoices, and a corrected invoice shows as edited', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/E2E-PO-MA-1/).first()).toBeVisible({ timeout: 45_000 });
  const href = await page
    .locator('tr, [role="row"], li')
    .filter({ hasText: /E2E-PO-MA-1/ })
    .locator('a[href^="/shipments/"]')
    .first()
    .getAttribute('href');
  expect(href).toMatch(/^\/shipments\/[\w-]+$/);
  await page.goto(href!, { waitUntil: 'domcontentloaded' });

  const row = invoiceRow(page);
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(row).toContainText('INV ');
  await expect(row).toContainText('E2EU2000001');
  await expect(row).toContainText(/12,000/);
  await expect(row).toContainText(/Partly paid|Unpaid|Paid/);

  // Correct the invoice — saved as it is, which is still a correction.
  await row.getByRole('link').first().click();
  await page.waitForURL(/\/sales\/[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByRole('link', { name: /Edit Invoice/ }).click();
  await page.waitForURL(/\/sales\/[\w-]+\/edit$/, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByRole('button', { name: /^Save changes$/ }).click();
  await expect(page.getByText('Invoice updated.').first()).toBeVisible({ timeout: 90_000 });

  await page.goto(href!, { waitUntil: 'domcontentloaded' });
  const again = invoiceRow(page);
  await expect(again).toContainText(/Edited/, { timeout: 45_000 });
  await expect(again).toContainText(new RegExp(ADMIN_NAME, 'i'));
  await expect(again).toContainText(/12,000/);
  console.log(`  ${href}: invoice listed with container, KG and payment; marked edited after the correction`);
});
