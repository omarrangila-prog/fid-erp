import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The journeys that have been failing in production most days: Save on a
 * master, Add Customer from an invoice, Delete on the sales list, Record
 * Payment, a journal in USD or MAD, an unpaid expense, a new expense category.
 *
 * Runs against the fixture trade in TEST_DATABASE_URL, never the live books.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the daily operations suite.');
test.describe.configure({ mode: 'serial' });

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

function unique(prefix: string) {
  return `${prefix} ${Date.now().toString(36).toUpperCase()}`;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToMorocco(page);
});

test('Customer Save adds the name to the list', async ({ page }) => {
  const name = unique('Daily Roasters');
  await page.goto('/customers?new=1', { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/customer name/i).fill(name);
  await page.getByRole('button', { name: /^create customer$/i }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
});

test('Supplier Save adds the name to the list', async ({ page }) => {
  const name = unique('Daily Fazenda');
  await page.goto('/vendors?new=1', { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/supplier name/i).fill(name);
  await page.getByRole('button', { name: /^save|^create/i }).first().click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
});

test('Add Customer from the invoice is selected immediately', async ({ page }) => {
  const name = unique('Invoice Walk-in');
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /^Add Customer$/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: /^Add Customer$/ })).toBeVisible();
  await sheet.getByLabel(/customer name/i).fill(name);
  await sheet.getByRole('button', { name: /^Save$/ }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('main')).toContainText(name);
});

test('the sales list keeps Cancel / Delete on an Actions menu', async ({ page }) => {
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('row').filter({ hasText: /FID-MA-SI-/ }).first();

  // View and Edit are on the row itself; anything destructive is one deliberate
  // click further in, behind the shared row-actions menu.
  await expect(row.getByRole('link', { name: /^View$/ })).toBeVisible();

  const actions = row.getByRole('button', { name: /more actions/i });
  await expect(actions).toBeVisible();
  await actions.click();
  await expect(page.getByRole('menuitem', { name: /cancel|delete/i }).first()).toBeVisible();
});

test('a posted credit invoice can be deleted from the invoice page, and leaves every list', async ({ page }) => {
  test.setTimeout(180_000);
  const name = unique('Delete-me Roasters');

  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Add Customer$/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel(/customer name/i).fill(name);
  await sheet.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });

  const form = page.getByRole('main');
  const warehouse = form.getByLabel(/^Warehouse/);
  const options = await warehouse.locator('option').count();
  if (options <= 1) {
    test.skip(true, 'No warehouse holds sellable stock in this company.');
    return;
  }
  await warehouse.selectOption({ index: 1 });

  await form.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.getByLabel(/Batch on item 1/).selectOption({ index: 1 });

  const quantity = form.getByRole('textbox', { name: /^Quantity/ }).first();
  const price = form.getByRole('textbox', { name: /Price/ }).first();
  await quantity.fill('60');
  await price.fill('6.00');
  await expect(quantity).toHaveValue('60');
  await expect(price).toHaveValue('6.00');

  await form.getByRole('button', { name: /^Save invoice$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  await expect(page.getByRole('heading', { name: /this page could|something went wrong/i })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/does not balance|does not match/i);

  const invoiceUrl = page.url();
  const invoiceNumber = (await page.getByRole('heading', { name: /FID-MA-SI-/ }).first().textContent()) ?? '';
  await page.getByRole('button', { name: /^Delete invoice$/ }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel(/why is this invoice being deleted/i).fill('Entered in error during daily test');
  await confirm.getByRole('button', { name: /^Delete invoice$/ }).click();
  await page.waitForURL(/\/sales\/?$/, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  await expect(page.getByRole('heading', { name: /Sales/i }).first()).toBeVisible();

  // Gone from the list, and the word "reversed" appears nowhere.
  const list = page.getByRole('main');
  await expect(list.getByRole('table').or(list.getByText(/no invoices/i)).first()).toBeVisible({ timeout: 30_000 });
  if (invoiceNumber) await expect(list).not.toContainText(invoiceNumber);
  await expect(list).not.toContainText(/reversed/i);

  // Opened by its old link it still resolves, and says deleted — never reversed.
  await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /this page could|something went wrong|not found/i })).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(/deleted/i);
  await expect(page.getByRole('main')).not.toContainText(/reversed/i);
});

test('Record Payment opens from an outstanding invoice', async ({ page }) => {
  await page.goto('/finance/receivables', { waitUntil: 'domcontentloaded' });
  const invoiceLink = page.getByRole('main').getByRole('link', { name: /INV|FID-/ }).first();
  if ((await invoiceLink.count()) === 0) {
    test.skip(true, 'Nothing is outstanding in this company.');
    return;
  }
  await invoiceLink.click();
  await page.waitForURL(/\/sales\/[\w-]+$/, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /Record payment/i }).click();
  await page.waitForURL(/\/finance\/receipts\/new/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main').getByLabel(/amount/i).first()).toBeEditable();
  await expect(page.getByRole('heading', { name: /this page could|something went wrong/i })).toHaveCount(0);
});

test('the journal can add an account without leaving the voucher', async ({ page }) => {
  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  // "+ Add New Account" is the first row of the account list, which is the one
  // way in now that the duplicate button beside each line is gone.
  await page.getByRole('combobox', { name: /line 1 account/i }).click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByPlaceholder('Search…') })
    .getByRole('button', { name: /Add New Account/i })
    .click();
  const dialog = page.getByRole('dialog').filter({ hasNot: page.getByPlaceholder('Search…') });
  await expect(dialog.getByRole('heading', { name: /Add New Account/i })).toBeVisible();
  await expect(dialog.getByLabel(/account name/i)).toBeEditable();
  await dialog.getByLabel(/account name/i).fill(`Daily Ahmed ${Date.now().toString(36)}`);
  await expect(dialog.getByLabel(/account type/i)).toHaveValue('PERSONAL');
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('main')).toContainText(/Ahmed/i);
});

test('the journal offers USD and MAD and posts a balanced USD voucher', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });

  const currency = page.getByLabel(/^Currency/);
  await expect(currency.locator('option[value="USD"]')).toHaveCount(1);
  await expect(currency.locator('option[value="MAD"]')).toHaveCount(1);
  await currency.selectOption('USD');

  await page.getByLabel(/description/i).fill('Daily ops USD opening');

  // Named accounts, not "whatever is first in the list": the first entries are
  // cash and bank drawers, and a drawer holds one currency only — a USD amount
  // cannot be recorded through the MAD till, so the form will not offer it.
  await page.getByRole('combobox', { name: /line 1 account/i }).click();
  await page.getByRole('listbox').getByRole('option', { name: /Freight and Logistics/i }).first().click();
  await page.getByLabel(/line 1 amount/i).fill('25');
  await page.getByRole('combobox', { name: /line 2 account/i }).click();
  await page.getByRole('listbox').getByRole('option', { name: /Ocean Freight/i }).first().click();
  await page.getByLabel(/line 2 amount/i).fill('25');
  await expect(page.getByText(/^balanced$/i)).toBeVisible();

  await page.getByRole('button', { name: /post voucher/i }).click();
  await page.waitForURL(/\/reports\/journal/, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByRole('main')).toContainText(/Daily ops USD opening/);
});

test('an unpaid expense does not ask Paid from, and a category can be added on the voucher', async ({ page }) => {
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await expect(form.getByText(/^Unpaid$/)).toBeVisible();

  await form.getByRole('button', { name: /Add New Category/i }).click();
  const dialog = page.getByRole('dialog');
  const category = unique('Daily fumigation');
  await dialog.getByLabel(/category name/i).fill(category);
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
  await expect(form).toContainText(category);
});

test('the customer ledger has separate USD and MAD tabs', async ({ page }) => {
  await page.goto('/ledgers/customers', { waitUntil: 'domcontentloaded' });
  const first = page.getByRole('main').getByRole('link').first();
  if ((await first.count()) === 0) {
    test.skip(true, 'No customers in this company.');
    return;
  }
  await first.click();
  await page.waitForURL(/\/ledgers\/customers\/[\w-]+/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: /^USD$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^MAD$/ })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/never mixed|never added together/i);
});

test('an item shows stock by warehouse', async ({ page }) => {
  await page.goto('/items', { waitUntil: 'domcontentloaded' });
  const item = page.getByRole('main').getByRole('link').first();
  if ((await item.count()) === 0) {
    test.skip(true, 'No items in this company.');
    return;
  }
  await item.click();
  await page.waitForURL(/\/items\/[\w-]+/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /stock by warehouse/i })).toBeVisible();
});

test('a plain MAD 7,400 shipment expense does not become 8,880', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await form.getByRole('combobox', { name: /contract \/ shipment/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();

  await form.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();

  await form.getByLabel(/expense date/i).fill('2026-07-28');
  await form.locator('label').filter({ hasText: /already paid from cash/i }).click();
  await form.getByLabel(/^Amount/).fill('7400');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) {
    await rate.fill('9.6');
  }
  await form.getByLabel(/^Description/).fill('Transport 7400 integrity');

  const tax = form.locator('#expenseTax');
  if (await tax.count()) {
    await expect(tax).toHaveValue('');
  }

  await expect(form).toContainText(/USD 770\.83/);

  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 40_000 });

  const expenseUrl = page.url();
  const main = page.getByRole('main');
  await expect(main).toContainText(/MAD 7,400/);
  await expect(main).toContainText(/USD 770\.83/);
  await expect(main).toContainText(/9\.6/);
  await expect(main).not.toContainText(/8,880/);
  await expect(main).not.toContainText(/Cash moved 20% more/);

  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  // Costing is one of the actions the shared row pattern keeps in plain sight,
  // next to View, rather than hiding behind the overflow menu.
  await page.getByRole('link', { name: /^Costing$/i }).first().click();
  const costing = page.locator('#costing');
  await expect(costing).toContainText(/7,400/);
  await expect(costing).not.toContainText(/8,880/);
  await expect(costing.getByRole('columnheader', { name: /Expense Category/i })).toBeVisible();
  await expect(costing.getByRole('columnheader', { name: /FX Rate/i })).toBeVisible();
  await expect(costing.getByRole('columnheader', { name: /USD Equivalent/i })).toBeVisible();
  await expect(costing.getByTestId('shipment-expense-row').filter({ hasText: '7,400' })).toHaveCount(1);

  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /Cash in Hand(?! \(USD\))/ }).first().click();
  await expect(page.getByRole('heading', { name: /Cash in Hand/ })).toBeVisible();
  const cashBook = page.getByRole('main');
  await expect(cashBook).toContainText(/7,400/);
  await expect(cashBook).not.toContainText(/8,880/);
  await expect(cashBook).toContainText(/MAD/);

  await page.getByRole('link', { name: /view general ledger/i }).click();
  await page.waitForURL(/\/reports\/general-ledger/, { waitUntil: 'domcontentloaded' });
  const ledger = page.getByRole('main');
  await expect(ledger).toContainText(/MAD lines only, in MAD/);
  await expect(ledger).not.toContainText(/USD lines only, in USD/);
  await expect(ledger).toContainText(/7,400/);
  await expect(ledger).not.toContainText(/8,880/);

  await page.goto('/accounting/chart', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /Cash in Hand \(MAD\)/ }).first().click();
  await page.waitForURL(/\/reports\/general-ledger/, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/MAD lines only, in MAD/);
  await expect(page.getByRole('main')).not.toContainText(/USD lines only, in USD/);
  await expect(page.getByRole('main')).toContainText(/7,400/);

  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const next = page.getByRole('main');
  await next.getByRole('combobox', { name: /contract \/ shipment/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await next.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await next.getByLabel(/expense date/i).fill('2026-07-29');
  await next.locator('label').filter({ hasText: /already paid from cash/i }).click();
  await next.getByLabel(/^Amount/).fill('1000');
  await next.getByLabel(/^Description/).fill('Second expense after 7400');
  await next.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  await expect(page.getByRole('main')).toContainText(/MAD 1,000/);
  await expect(page.getByRole('main')).not.toContainText(/1,200/);

  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /Cash in Hand(?! \(USD\))/ }).first().click();
  await expect(page.getByRole('main')).toContainText(/1,000/);
  await expect(page.getByRole('main')).not.toContainText(/1,200/);

  await page.goto(expenseUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/MAD 7,400/);
});
