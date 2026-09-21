import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The supplier bill, and what a posted document did to the ledger.
 *
 * Recording a cost that has not been paid yet is the most ordinary thing an
 * accounts department does, and until now the form had no way to say who the
 * money was owed to: it offered an Unpaid option and then sent nothing that
 * named a party, so the voucher could not be recorded at all. These two walk
 * the path a bookkeeper actually walks — enter the bill, post it, see it in
 * payables, and read the entry it wrote.
 *
 * Runs against the fixture trade in TEST_DATABASE_URL, never the live books.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the supplier bill suite.');
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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToMorocco(page);
});

test('an unpaid cost is booked with nobody named, and paid later from cash', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // A cost of running the business, not paid yet.
  await form.locator('label').filter({ hasText: /running the business/i }).click();
  await form.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.locator('label').filter({ hasText: /Book the cost now/i }).click();

  // Unpaid asks for nothing about who is owed or how it will be paid.
  await expect(form.getByRole('combobox', { name: /supplier/i })).toHaveCount(0);
  await expect(form.getByLabel(/^owed to/i)).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: /^(cash|bank) account/i })).toHaveCount(0);

  await form.getByLabel(/expense date/i).fill('2026-07-29');
  await form.getByLabel(/^Amount/).fill('4000');
  await form.getByLabel(/^Memo/).fill('Office rent, invoice to follow');

  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const main = page.getByRole('main');
  await expect(main).toContainText(/POSTED/i);
  await expect(main).toContainText(/4,000/);
  // The entry it wrote goes to Accrued Expenses, not to any supplier.
  await expect(main).toContainText(/Accrued Expenses/i);

  // Later: pay it from the cost itself. No supplier is asked for.
  await main.getByRole('link', { name: /record payment/i }).click();
  await page.waitForURL(/\/finance\/payments\/new/, { waitUntil: 'domcontentloaded' });
  const pay = page.getByRole('main');
  await expect(pay.getByRole('combobox', { name: /supplier/i })).toHaveCount(0);
  // The field names the cost being settled in words — the category or the
  // description — rather than the system's own voucher number.
  const settles = pay.getByLabel(/settles/i);
  await expect(settles).toHaveAttribute('readonly', '');
  await expect(settles).not.toHaveValue('');
  await expect(pay.getByLabel(/^Amount/).first()).toHaveValue('4000');

  await pay.getByLabel(/payment method/i).selectOption('CASH');
  await pay.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/payments\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(/POSTED/i);
  await expect(page.getByRole('main')).toContainText(/Accrued Expenses/i);
});

test('a posted document shows the journal entry it wrote', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });

  const first = page.getByRole('main').getByRole('link', { name: /INV\s*\d+/ }).first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.click();
  await page.waitForURL(/\/sales\/[\w-]+/, { waitUntil: 'domcontentloaded' });

  // The entry the invoice wrote, on the invoice itself.
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: /^Journal$/ })).toBeVisible({ timeout: 30_000 });
  await expect(main.getByRole('columnheader', { name: /^Debit$/ })).toBeVisible();
  await expect(main.getByRole('columnheader', { name: /^Credit$/ })).toBeVisible();

  // And it names the accounts, so the document explains itself.
  await expect(main).toContainText(/Accounts Receivable|Sales/i);
});

test('one payment split across three categories posts three expenses', async ({ page }) => {
  test.setTimeout(180_000);
  const reference = `PORT-${Date.now().toString(36).toUpperCase()}`;

  const before = await countExpenses(page);

  await page.goto('/finance/expenses/split', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await form.getByRole('combobox', { name: /contract \/ shipment/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.getByLabel(/^Reference/).fill(reference);

  // Three lines: the second is there by default, the third is added.
  await form.getByRole('button', { name: /add line/i }).click();

  const amounts = ['10000', '5000', '5000'];
  for (let i = 0; i < 3; i += 1) {
    await form.getByRole('combobox', { name: `Category on line ${i + 1}` }).click();
    await page.getByRole('listbox').getByRole('option').nth(i).click();
    await form.getByLabel(`Amount on line ${i + 1}`).fill(amounts[i]);
  }
  await expect(form).toContainText(/20,000/);

  await form.getByRole('button', { name: /post all lines/i }).click();
  await expect(page.getByText(/3 expenses posted from one payment/i)).toBeVisible({ timeout: 60_000 });
  await page.waitForURL(/\/finance\/expenses$/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Three more vouchers on the list, every one of them posted.
  await expect
    .poll(async () => countExpenses(page), { timeout: 30_000 })
    .toBe(before + 3);
  // The three newest rows are the ones just posted; each says so.
  const rows = page.getByRole('main').getByRole('table').getByRole('row');
  for (let i = 1; i <= 3; i += 1) {
    await expect(rows.nth(i)).toContainText(/Posted/i);
  }
});

/** How many expense vouchers the list shows, once it has actually rendered. */
async function countExpenses(page: Page) {
  await page.goto('/finance/expenses', { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  // The table or the empty state, whichever this company has — not the
  // moment before either has painted.
  await expect(main.getByRole('table').or(main.getByText(/no expenses/i)).first()).toBeVisible({ timeout: 30_000 });
  // Every data row of the list: the voucher number is no longer printed, so
  // the rows themselves are what there is to count.
  return main.getByRole('table').getByRole('row').count();
}
