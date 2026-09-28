import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * One financial truth, through the screens.
 *
 * A cost paid on the spot reads Paid; one booked unpaid reads Unpaid, then
 * Partially settled at MAD 5,000 of 20,000, then Paid — on its own page, on
 * the Unpaid Expenses ledger and on the dashboard, each step. A journal
 * voucher that pays Accrued Expenses without naming a cost lowers the unpaid
 * total by exactly its amount, and the ledgers still agree. And every agent's
 * dashboard card shows the balance his own ledger shows, after a reload.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const RUN = Date.now().toString(36).slice(-5);
const PAID = `E2E truth paid ${RUN}`;
const OWED = `E2E truth owed ${RUN}`;
const BY_JV = `E2E truth by JV ${RUN}`;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
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

const figure = (text: string) => Number((text.match(/MAD ([\d,]+\.\d{2})/)?.[1] ?? '0').replace(/,/g, ''));

/** The dashboard's unpaid-expenses figure, freshly loaded. */
async function dashboardUnpaid(page: Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('outstanding-unpaid-expenses');
  await expect(card).toBeVisible({ timeout: 60_000 });
  return figure(await card.innerText());
}

/** A general cost: paid from cash, or booked unpaid to nobody yet (Accrued Expenses). */
async function book(page: Page, params: { amount: string; memo: string; paid: boolean }) {
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByRole('main');
  await form.locator('label').filter({ hasText: /running the business/i }).click();
  await form.locator('label').filter({ hasText: params.paid ? /^Paid/ : /^Unpaid/ }).first().click();
  if (params.paid) await form.getByRole('combobox', { name: /^paid from/i }).selectOption('CASH');
  await choose(page, form.getByRole('combobox', { name: /^category/i }));
  await form.getByLabel(/^Amount/).fill(params.amount);
  await form.getByLabel(/^Memo/).fill(params.memo);
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(params.memo);
  return page.url();
}

async function expectExpense(page: Page, url: string, status: RegExp, outstanding?: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('expense-payment-badge')).toHaveText(status, { timeout: 30_000 });
  if (outstanding !== undefined) await expect(page.getByTestId('expense-outstanding')).toHaveText(`MAD ${outstanding}`);
}

async function settleInCash(page: Page, memo: string, amount?: string) {
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  const row = page.getByTestId('unpaid-schedule').getByRole('row').filter({ hasText: memo }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByTestId('settle-expense').click();
  const dialog = page.getByTestId('settle-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Today$/ }).click();
  await dialog.getByLabel(/^Cash$/).check();
  await choose(page, dialog.locator('#settleAccount'));
  if (amount) await dialog.locator('#settleAmount').fill(amount);
  await page.getByTestId('post-settlement').click();
  await expect(page.getByText(/Settlement posted\./).first()).toBeVisible({ timeout: 90_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

let owedUrl = '';
let baseline = 0;

test('paid from cash reads Paid, and the unpaid total does not move', async ({ page }) => {
  baseline = await dashboardUnpaid(page);
  const url = await book(page, { amount: '10000', memo: PAID, paid: true });
  await expectExpense(page, url, /^Paid$/);
  expect(await dashboardUnpaid(page)).toBeCloseTo(baseline, 2);
});

test('booked unpaid reads Unpaid, MAD 20,000 on its page, the ledger and the dashboard', async ({ page }) => {
  owedUrl = await book(page, { amount: '20000', memo: OWED, paid: false });
  await expectExpense(page, owedUrl, /^Unpaid$/, '20,000.00');
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('unpaid-schedule').getByRole('row').filter({ hasText: OWED }).first()).toContainText('Unpaid', { timeout: 45_000 });
  expect(await dashboardUnpaid(page)).toBeCloseTo(baseline + 20_000, 2);
});

test('MAD 5,000 paid: Partially settled, MAD 15,000 left on every screen', async ({ page }) => {
  await settleInCash(page, OWED, '5000');
  await expectExpense(page, owedUrl, /^Partially Settled$/, '15,000.00');
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  const row = page.getByTestId('unpaid-schedule').getByRole('row').filter({ hasText: OWED }).first();
  await expect(row).toContainText('Partially Settled', { timeout: 45_000 });
  await expect(row).toContainText(/MAD 15,000\.00/);
  expect(await dashboardUnpaid(page)).toBeCloseTo(baseline + 15_000, 2);
});

test('the other MAD 15,000: Paid, and gone from the unpaid total', async ({ page }) => {
  await settleInCash(page, OWED);
  await expectExpense(page, owedUrl, /^Paid$/, '0.00');
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('unpaid-total')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('unpaid-schedule').getByRole('row').filter({ hasText: OWED })).toHaveCount(0);
  expect(await dashboardUnpaid(page)).toBeCloseTo(baseline, 2);
});

test('a journal voucher that pays Accrued Expenses lowers what every screen calls unpaid, by exactly its amount', async ({ page }) => {
  const url = await book(page, { amount: '3000', memo: BY_JV, paid: false });
  await expectExpense(page, url, /^Unpaid$/, '3,000.00');
  const before = await dashboardUnpaid(page);

  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Journal Entry (JV)', level: 1 })).toBeVisible({ timeout: 45_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByTestId('simple-entry');
  await choose(page, form.locator('#ge-debit'), 'Accrued Expenses');
  await choose(page, form.locator('#ge-credit'), 'Cash');
  await form.locator('#ge-amount').fill('3000');
  await form.locator('#ge-memo').fill(`Pays ${BY_JV}`);
  await page.getByTestId('post-entry').click();
  await page.waitForURL(/\/reports\/journal/, { timeout: 60_000 });

  // A voucher names no cost, so it pays the oldest still owed; the costs
  // then read paid by exactly what the ledger says went out.
  expect(await dashboardUnpaid(page)).toBeCloseTo(before - 3_000, 2);
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('unpaid-reconciliation')).not.toContainText('Differs', { timeout: 45_000 });
  await page.goto('/admin/consistency', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('consistency-summary')).toContainText(/All \d+ checks agree/, { timeout: 60_000 });
});

test('every agent’s dashboard card shows the balance on his own ledger, before and after a reload', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const cards = page.getByTestId('outstanding-agent');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  const seen: Array<{ href: string; balance: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    seen.push({
      href: (await card.getByRole('link', { name: 'Open agent ledger' }).getAttribute('href'))!,
      balance: (await card.getByTestId('outstanding-agent-balance').innerText()).trim(),
    });
  }
  for (const { href, balance } of seen) {
    for (const reload of [false, true]) {
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
      const ledger = (await page.getByTestId('agent-net-balance').innerText({ timeout: 45_000 })).trim();
      expect(ledger, href).toBe(balance);
      // And the ledger closes on the same figure.
      const closing = page.getByTestId('agent-ledger').getByTestId('ledger-summary').locator('dd').last();
      expect((await closing.innerText()).trim(), href).toBe(balance);
    }
  }
  console.log(`  ${RUN}: ${seen.map((s) => s.balance).join(', ')} — dashboard = ledger`);
});
