import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * "Reversed" appears nowhere a person works.
 *
 * A posted document that is taken back leaves a mirror entry in the books —
 * that is what keeps the ledger whole — but to the person using the
 * application the document was deleted, and no screen should say otherwise.
 * This deletes a posted invoice and then reads every screen the client named,
 * looking for the word.
 *
 * Runs against the fixture trade in TEST_DATABASE_URL, never the live books.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });

const SCREENS = [
  '/dashboard',
  '/sales',
  '/sales/credit-notes',
  '/purchases',
  '/finance/receipts',
  '/finance/payments',
  '/finance/expenses',
  '/finance/cash-bank',
  '/finance/receivables',
  '/finance/payables',
  '/ledgers/customers',
  '/inventory/movements',
  '/reports/journal',
  '/reports/general-ledger',
  '/reports/trial-balance',
  '/reports/profit-loss',
];

async function signInToMorocco(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToMorocco(page);
});

test('after a posted invoice is deleted, no screen says "reversed" and the invoice is on none of them', async ({ page }) => {
  test.setTimeout(300_000);
  const name = `Wordcheck Roasters ${Date.now().toString(36).toUpperCase()}`;

  // --- Raise and post an invoice, then delete it -------------------------
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Add Customer$/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel(/customer name/i).fill(name);
  await sheet.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });

  const form = page.getByRole('main');
  const warehouse = form.getByLabel(/^Warehouse/);
  if ((await warehouse.locator('option').count()) - 1 > 1) await warehouse.selectOption({ index: 1 });
  await form.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.getByLabel(/Batch on item 1/).selectOption({ index: 1 });
  await form.getByRole('textbox', { name: /^Quantity/ }).first().fill('60');
  await form.getByRole('textbox', { name: /Price/ }).first().fill('6.00');
  await form.getByRole('button', { name: /^Save invoice$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 40_000 });

  const invoiceNumber = (await page.getByRole('heading', { name: /FID-MA-SI-/ }).first().textContent())?.trim() ?? '';
  expect(invoiceNumber).toMatch(/FID-MA-SI-/);

  await page.getByRole('button', { name: /^Delete invoice$/ }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel(/why is this invoice being deleted/i).fill('Word check');
  await confirm.getByRole('button', { name: /^Delete invoice$/ }).click();
  await page.waitForURL(/\/sales\/?$/, { waitUntil: 'domcontentloaded', timeout: 40_000 });

  // --- Read every screen -------------------------------------------------
  const offenders: string[] = [];
  for (const path of SCREENS) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    await expect(main).toBeVisible({ timeout: 30_000 });
    // Let the data land before reading the page.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    const text = (await main.innerText()).toLowerCase();
    if (/revers/.test(text)) offenders.push(`${path}: says "reversed"`);
    if (invoiceNumber && text.includes(invoiceNumber.toLowerCase())) offenders.push(`${path}: still lists ${invoiceNumber}`);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});
