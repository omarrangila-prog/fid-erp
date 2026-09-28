import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * A partly paid invoice is still outstanding.
 *
 * The Moroccan fixture's invoice to E2E Torréfacteur Casablanca is part paid:
 * MAD 300,000 by bank and two agent collections. The dashboard counts it at
 * what is left, the Outstanding list includes it beside the unpaid ones, and
 * the invoice itself lists every real payment — the agent collections among
 * them — with total, paid and outstanding that add up.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.setTimeout(180_000);

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

const figure = (text: string) => Number((text.match(/MAD ([\d,]+\.\d{2})/)?.[1] ?? '0').replace(/,/g, ''));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('the dashboard counts partly paid invoices at what is left, and opens the Outstanding list', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('outstanding-invoices');
  await expect(card).toBeVisible({ timeout: 60_000 });
  const unpaid = figure(await page.getByTestId('outstanding-invoices-unpaid').innerText());
  const partial = figure(await page.getByTestId('outstanding-invoices-partial').innerText());
  const total = figure(await page.getByTestId('outstanding-invoices-total').innerText());
  expect(partial).toBeGreaterThan(0);
  expect(total).toBeCloseTo(unpaid + partial, 2);

  await card.getByRole('link', { name: /Outstanding customer invoices/ }).click();
  await page.waitForURL(/\/sales\?standing=OUTSTANDING/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('invoice-standing-active')).toContainText(/outstanding/, { timeout: 30_000 });
  const rows = page.locator('main table tbody tr');
  await expect(rows.filter({ hasText: /Partially Paid/ }).first()).toBeVisible();
  // The customer summary opens with it: invoiced, received, still owed.
  await expect(page.getByTestId('sales-by-customer')).toContainText('E2E Torréfacteur Casablanca');
});

test('the invoice lists every real payment, agent collections included, and the figures add up', async ({ page }) => {
  await page.goto('/sales?standing=OUTSTANDING', { waitUntil: 'domcontentloaded' });
  const row = page.locator('main table tbody tr').filter({ hasText: 'E2E Torréfacteur Casablanca' }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByRole('link', { name: /INV \d+/ }).first().click();
  await page.waitForURL(/\/sales\/[\w-]+$/, { waitUntil: 'domcontentloaded' });

  const main = page.getByRole('main');
  await expect(main).toContainText(/Agent cheque \/ Agent collection — E2E Settlement Agent/, { timeout: 30_000 });
  await expect(main).toContainText(/Bank Transfer/);
  const summary = (await page.getByTestId('invoice-payment-summary').innerText()).replace(/\s+/g, ' ');
  const read = (label: string) => figure(summary.split(label)[1] ?? '');
  const totalAmount = read('Invoice total');
  const paid = read('Total paid');
  const outstanding = read('Outstanding');
  expect(paid).toBeGreaterThanOrEqual(400_000);
  expect(totalAmount - paid).toBeCloseTo(outstanding, 2);
  expect(summary).toMatch(/Partially Paid/i);
  console.log(`  invoice: total ${totalAmount}, paid ${paid}, outstanding ${outstanding}, partially paid`);
});
