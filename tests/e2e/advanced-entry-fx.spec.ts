import { test, expect, type Page } from '@playwright/test';

/**
 * Advanced journal entry, in the client's own case: MAD 2,100 leaves the
 * Moroccan bank and the supplier is credited USD 200.
 *
 * The supplier is chosen by name, each side takes its own currency, the rate
 * is asked once and worked out from the two amounts (10.50), the preview is the
 * payment's own entry and balances in MAD, and posting writes one supplier
 * payment against the order. An entry all in MAD asks no rate at all.
 */
const ADMIN_PIN = process.env.ADMIN_PIN;
const MOROCCO = /FID Trading International SARL/i;
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the advanced entry tests.');

async function signInToMorocco(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of ADMIN_PIN!.split('')) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
  const switcher = page.getByRole('button', { name: /FID / }).first();
  if (await switcher.count()) {
    if (!MOROCCO.test((await switcher.textContent()) ?? '')) {
      await switcher.click();
      await page.getByRole('menuitem', { name: MOROCCO }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

async function openAdvanced(page: Page) {
  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /advanced journal entry/i }).click();
}

async function choose(page: Page, line: number, name: RegExp) {
  await page.getByRole('combobox', { name: new RegExp(`line ${line} account`, 'i') }).click();
  await page.getByRole('listbox').getByRole('option', { name }).first().click();
}

test('MAD to MAD asks no exchange rate', async ({ page }) => {
  await signInToMorocco(page);
  await openAdvanced(page);
  await choose(page, 1, /Freight and Logistics/i);
  await page.getByLabel(/line 1 amount/i).fill('500');
  await choose(page, 2, /MAD Bank Account/i);
  await page.getByLabel(/line 2 amount/i).fill('500');
  await expect(page.getByText(/^balanced$/i)).toBeVisible();
  await expect(page.getByTestId('jv-rates')).toHaveCount(0);
  await expect(page.getByTestId('jv-difference')).toContainText('0.00');
});

test('MAD bank to the supplier in USD: one rate, worked out, previewed, posted once', async ({ page }) => {
  test.setTimeout(180_000);
  await signInToMorocco(page);
  await openAdvanced(page);
  await page.locator('#jv-description').fill('E2E MAD bank to Uganda supplier');

  // The supplier by name: the line takes the supplier's USD.
  await choose(page, 1, /E2E Exporter Uganda/i);
  await expect(page.getByLabel(/line 1 currency/i)).toHaveValue('USD');
  await page.getByLabel(/line 1 amount/i).fill('200');
  // The Moroccan bank: the line takes MAD.
  await choose(page, 2, /MAD Bank Account/i);
  await expect(page.getByLabel(/line 2 currency/i)).toHaveValue('MAD');
  await page.getByLabel(/line 2 amount/i).fill('2100');

  // One rate, worked out from the two amounts.
  const rates = page.getByTestId('jv-rates');
  await expect(rates.getByRole('textbox')).toHaveCount(1);
  await expect(rates.getByLabel(/MAD per USD/i)).toHaveValue('10.5');
  await expect(page.getByTestId('jv-effective-rate')).toContainText('1 USD = 10.5 MAD');
  await expect(page.getByText(/^balanced$/i)).toBeVisible();

  // What it pays: the order, not an invented invoice.
  const settles = page.getByTestId('jv-supplier-payment').getByLabel(/what does this pay/i);
  await expect(settles.locator('option', { hasText: /E2E-PO-MA-1/ })).toHaveCount(1, { timeout: 30_000 });
  await settles.selectOption({ label: (await settles.locator('option', { hasText: /E2E-PO-MA-1/ }).first().innerText()).trim() });

  // The preview is the payment's own entry, balanced in MAD.
  const preview = page.getByTestId('jv-preview-lines');
  await expect(preview).toContainText(/Accounts Payable|Supplier Payables/, { timeout: 30_000 });
  await expect(preview).toContainText('MAD Bank Account');
  await expect(preview).toContainText('MAD 2,100.00');
  await expect(page.getByTestId('jv-difference')).toContainText('0.00');

  await page.getByRole('button', { name: /post entry/i }).click();
  await page.waitForURL(/\/finance\/payments/, { timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(/E2E Exporter Uganda/, { timeout: 30_000 });
});
