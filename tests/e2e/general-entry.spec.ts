import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * General Entry — choose the kind of entry and the two accounts; the debit
 * and credit are shown before anything is posted.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const RUN = Date.now().toString(36).slice(-5);

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
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

async function choose(page: Page, combobox: Locator, text?: string | RegExp) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await combobox.click();
    if (typeof text === 'string') await page.keyboard.type(text, { delay: 20 });
    const options = page.getByRole('listbox').getByRole('option');
    const option = text ? options.filter({ hasText: text }).first() : options.first();
    const shown = await option.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (shown && (await option.click({ timeout: 5_000 }).then(() => true).catch(() => false))) return;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  throw new Error('the picker never stayed open long enough to choose');
}

async function open(page: Page) {
  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Journal Entry (JV)', level: 1 })).toBeVisible({ timeout: 45_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return page.getByTestId('simple-entry');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('an expense paid from cash: MAD 1,000, both sides shown before posting', async ({ page }) => {
  const form = await open(page);
  await form.getByLabel('Transaction type').selectOption({ label: 'Expense' });
  await expect(form.getByText(/^Paid from/).first()).toBeVisible();
  await choose(page, form.locator('#ge-debit'));
  await choose(page, form.locator('#ge-credit'), 'Cash');
  await form.locator('#ge-amount').fill('1000');
  await form.locator('#ge-memo').fill(`General entry ${RUN}`);
  const preview = page.getByTestId('entry-preview');
  await expect(preview).toContainText(/Debit[\s\S]*MAD 1,000\.00/);
  await expect(preview).toContainText(/Credit[\s\S]*Cash[\s\S]*MAD 1,000\.00/);
  await expect(preview).toContainText(/falls/);
  await page.getByTestId('post-entry').click();
  await page.waitForURL(/\/reports\/journal/, { timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(`General entry ${RUN}`, { timeout: 30_000 });
});

test('a ledger adjustment moves no cash, and an account can be added without leaving the form', async ({ page }) => {
  const form = await open(page);
  await form.getByLabel('Transaction type').selectOption({ label: 'Ledger adjustment / set-off' });
  await choose(page, form.locator('#ge-debit'), 'E2E Clearing Agent');
  // The credit side is a new account, added from the picker itself.
  await form.locator('#ge-credit').click();
  await page.keyboard.type(`Adjust ${RUN}`, { delay: 20 });
  await page.getByRole('button', { name: /\+ Add Account/ }).click();
  const dialog = page.getByRole('dialog').filter({ hasNot: page.getByPlaceholder('Search…') });
  await expect(dialog.getByLabel(/account name/i)).toHaveValue(`Adjust ${RUN}`);
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(form.locator('#ge-credit')).toContainText(`Adjust ${RUN}`);
  await form.locator('#ge-amount').fill('250');
  await expect(page.getByTestId('entry-preview')).toContainText(/None — no cash or bank moves/);
  await page.getByTestId('post-entry').click();
  await page.waitForURL(/\/reports\/journal/, { timeout: 60_000 });
});

test('the multi-line journal is still one click away', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /advanced journal entry/i }).click();
  await expect(page.locator('#jv-description')).toBeVisible();
});
