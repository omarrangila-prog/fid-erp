import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Creating master data without losing the voucher you were writing.
 *
 * The rule these check is the one that matters: work already typed into the
 * transaction survives. A quick create that saved the record but cleared the
 * amount, the date or the other lines would be worse than sending the user to
 * the master screen, because the loss is silent.
 *
 * Runs against the fixture trade in TEST_DATABASE_URL, never the live books.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the quick-create suite.');
test.describe.configure({ mode: 'serial' });

const unique = (prefix: string) => `${prefix} ${Date.now().toString(36).toUpperCase()}`;

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

/**
 * Open a picker's quick create, fill the name, save, and wait for it to close.
 *
 * The create row is clicked inside the open list rather than on the page: a
 * couple of forms also keep a standalone Add button beside the picker, and a
 * bare page-wide lookup matches both. The modal is likewise identified by its
 * absence of that search box, because an open combobox is a popover and
 * reports itself as a dialog too.
 */
async function quickCreate(
  page: Page,
  picker: ReturnType<Page['getByRole']>,
  button: RegExp,
  nameLabel: RegExp,
  name: string,
) {
  await picker.click();
  const list = page.getByRole('dialog').filter({ has: page.getByPlaceholder('Search…') });
  await list.getByRole('button', { name: button }).click();

  // Everything that is a dialog but is not the combobox's own search popover.
  const modal = page.getByRole('dialog').filter({ hasNot: page.getByPlaceholder('Search…') });
  await modal.getByLabel(nameLabel).fill(name);
  await modal.getByRole('button', { name: /^Save$/ }).click();
  await expect(modal).toHaveCount(0, { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToMorocco(page);
});

test('an expense keeps everything typed while a category and a supplier are added', async ({ page }) => {
  test.setTimeout(180_000);
  const category = unique('Laboratory Testing');
  const supplier = unique('Analytica');

  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await form.locator('label').filter({ hasText: /running the business/i }).click();
  await form.locator('label').filter({ hasText: /Book the cost now/i }).click();

  // Type the voucher FIRST, so the quick creates have something to lose.
  await form.getByLabel(/expense date/i).fill('2026-08-03');
  await form.getByLabel(/^Amount/).fill('3175.50');
  await form.getByLabel(/^Description/).fill('Moisture and density certificate');

  await quickCreate(
    page,
    form.getByRole('combobox', { name: /expense category/i }),
    /Add New Category/i,
    /category name/i,
    category,
  );
  await expect(form.getByRole('combobox', { name: /expense category/i })).toContainText(category);

  await quickCreate(
    page,
    form.getByRole('combobox', { name: /supplier/i }),
    /Add New Supplier/i,
    /supplier name/i,
    supplier,
  );
  await expect(form.getByRole('combobox', { name: /supplier/i })).toContainText(supplier);

  // Nothing typed before the two dialogs may have been lost.
  await expect(form.getByLabel(/^Amount/)).toHaveValue('3175.50');
  await expect(form.getByLabel(/^Description/)).toHaveValue('Moisture and density certificate');
  await expect(form.getByLabel(/expense date/i)).toHaveValue('2026-08-03');

  // And the voucher still posts, against the supplier just created.
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(/POSTED/i);
  await expect(page.getByRole('main')).toContainText(/3,175\.50/);
});

test('a purchase contract can name a coffee that did not exist yet', async ({ page }) => {
  test.setTimeout(180_000);
  const coffee = unique('Kivu Robusta');

  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await form.getByLabel(/contract reference/i).fill(unique('QC-REF'));

  const picker = form.getByRole('combobox', { name: /^Coffee/i }).first();
  await picker.click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByPlaceholder('Search…') })
    .getByRole('button', { name: /Add New Item/i })
    .click();
  // Everything that is a dialog but is not the combobox's own search popover.
  const modal = page.getByRole('dialog').filter({ hasNot: page.getByPlaceholder('Search…') });
  await modal.getByLabel(/item name/i).fill(coffee);
  await modal.getByLabel(/origin country/i).fill('Congo');
  await modal.getByRole('button', { name: /^Save$/ }).click();
  await expect(modal).toHaveCount(0, { timeout: 20_000 });

  await expect(picker).toContainText(coffee);

  // It is a real item afterwards, editable from its own screen.
  await page.goto('/items', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(coffee, { timeout: 30_000 });
});

test('a bank account opened from a receipt becomes a real ledger account', async ({ page }) => {
  test.setTimeout(180_000);
  const account = unique('CIH Bank');

  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // Bank transfer, so the form asks which account rather than assuming cash.
  await form.getByLabel(/payment method/i).selectOption('BANK_TRANSFER');

  const picker = form.getByRole('combobox', { name: /received into/i });
  await picker.click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByPlaceholder('Search…') })
    .getByRole('button', { name: /Add New (Bank|Cash) Account/i })
    .click();
  // Everything that is a dialog but is not the combobox's own search popover.
  const modal = page.getByRole('dialog').filter({ hasNot: page.getByPlaceholder('Search…') });
  await modal.getByLabel(/account name/i).fill(account);
  await modal.getByRole('button', { name: /^Save$/ }).click();
  await expect(modal).toHaveCount(0, { timeout: 20_000 });
  await expect(picker).toContainText(account);

  // Opening a drawer opens a ledger account with it — that is the whole point.
  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(account, { timeout: 30_000 });

  await page.goto('/accounting/chart', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(account, { timeout: 30_000 });
});
