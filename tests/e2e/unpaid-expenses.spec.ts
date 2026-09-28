import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Unpaid Expenses, through the screens a user has.
 *
 * Two shipment costs are booked unpaid on the Moroccan fixture's order — a
 * MAD 30,000 commission owed to E2E Settlement Agent (who holds MAD 50,000 of
 * a customer's money) and MAD 9,000 of rent owed to nobody yet — and a third,
 * MAD 2,000, for the cheque. Then, from the Unpaid Expenses ledger:
 *
 *   the rent is paid MAD 4,000 from the bank      partially settled, 5,000 left
 *   and the rest in cash                          settled
 *   the commission is set off against his holding settled; he holds 20,000
 *   the third is paid by cheque                   settled
 *
 * and after a reload every figure is still where it was left.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const RUN = Date.now().toString(36).slice(-5);
const COMMISSION = `E2E unpaid commission ${RUN}`;
const RENT = `E2E unpaid rent ${RUN}`;
const THIRD = `E2E unpaid cheque ${RUN}`;

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

/** Open a picker, narrow it by typing, and choose the entry; reopen if it closes under the click. */
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

async function bookUnpaid(page: Page, params: { amount: string; memo: string; payee?: string }) {
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByRole('main');
  await choose(page, form.getByRole('combobox', { name: /contract \/ shipment/i }), 'E2E-PO-MA-1');
  await choose(page, form.getByRole('combobox', { name: /expense category/i }));
  await form.getByLabel(/^Amount/).fill(params.amount);
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('9.85');
  await form.getByLabel(/^Memo/).fill(params.memo);
  if (params.payee) await choose(page, form.locator('#expensePayee'), params.payee);
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(params.memo);
}

function ledgerRow(page: Page, memo: string) {
  return page.getByRole('row').filter({ hasText: memo }).first();
}

async function openLedger(page: Page, view: 'outstanding' | 'all' = 'outstanding') {
  await page.goto(`/finance/unpaid-expenses${view === 'all' ? '?view=all' : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('unpaid-total')).toBeVisible({ timeout: 45_000 });
}

async function settle(
  page: Page,
  memo: string,
  params: { method: RegExp; amount?: string; account?: boolean; cheque?: { number: string; to: string }; expectPreview?: RegExp },
) {
  await openLedger(page);
  const row = ledgerRow(page, memo);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId('settle-expense').click();
  const dialog = page.getByTestId('settle-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Today$/ }).click();
  await dialog.getByLabel(params.method).check();
  if (params.account) await choose(page, dialog.locator('#settleAccount'));
  if (params.cheque) {
    await dialog.locator('#chequeNumber').fill(params.cheque.number);
    await dialog.locator('#chequeBeneficiary').fill(params.cheque.to);
  }
  if (params.amount) await dialog.locator('#settleAmount').fill(params.amount);
  if (params.expectPreview) await expect(page.getByTestId('setoff-preview')).toContainText(params.expectPreview);
  await page.getByTestId('post-settlement').click();
  await expect(page.getByText(/Settlement posted\.|Adjustment posted\./).first()).toBeVisible({ timeout: 90_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('unpaid costs booked on the form appear on the ledger under the party they are owed to', async ({ page }) => {
  await bookUnpaid(page, { amount: '30000', memo: COMMISSION, payee: 'E2E Settlement' });
  await bookUnpaid(page, { amount: '9000', memo: RENT });
  await bookUnpaid(page, { amount: '2000', memo: THIRD });

  await openLedger(page);
  const commission = ledgerRow(page, COMMISSION);
  await expect(commission).toContainText('E2E Settlement Agent');
  await expect(commission).toContainText(/MAD 30,000\.00/);
  await expect(commission).toContainText('Unpaid');
  const rent = ledgerRow(page, RENT);
  await expect(rent).toContainText('General / unassigned');
  await expect(rent).toContainText(/MAD 9,000\.00/);
  await expect(page.getByTestId('unpaid-reconciliation')).not.toContainText('Differs');
});

test('the rent is settled in two parts — bank, then cash — and reads partially settled in between', async ({ page }) => {
  await settle(page, RENT, { method: /^Bank$/, amount: '4000', account: true });
  await openLedger(page);
  const rent = ledgerRow(page, RENT);
  await expect(rent).toContainText('Partially settled');
  await expect(rent).toContainText(/MAD 5,000\.00/);

  await settle(page, RENT, { method: /^Cash$/, account: true });
  await openLedger(page);
  await expect(ledgerRow(page, RENT)).toHaveCount(0);
});

test('the commission is set off against what the agent holds, and no cash or bank moves', async ({ page }) => {
  await settle(page, COMMISSION, { method: /Ledger adjustment/, expectPreview: /MAD 20,000\.00/ });
  await openLedger(page);
  await expect(ledgerRow(page, COMMISSION)).toHaveCount(0);
});

test('the third is paid by cheque', async ({ page }) => {
  await settle(page, THIRD, { method: /^Cheque$/, account: true, cheque: { number: `CHQ-${RUN}`, to: 'IPSEN' } });
  await openLedger(page);
  await expect(ledgerRow(page, THIRD)).toHaveCount(0);
});

test('after a reload, every cost reads settled, with how it was settled', async ({ page }) => {
  await openLedger(page, 'all');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('unpaid-total')).toBeVisible({ timeout: 45_000 });
  for (const memo of [COMMISSION, RENT, THIRD]) await expect(ledgerRow(page, memo)).toContainText('Settled');

  // The rent's history: MAD 4,000 by bank and MAD 5,000 in cash.
  const rent = ledgerRow(page, RENT);
  await rent.getByRole('button', { name: 'Show detail' }).click();
  // The detail opens in the row directly beneath the cost.
  const history = rent.locator('xpath=following-sibling::tr[1]');
  await expect(history).toContainText(/Bank/);
  await expect(history).toContainText(/Cash/);
  await expect(history).toContainText(/MAD 4,000\.00/);
  await expect(history).toContainText(/MAD 5,000\.00/);

  // The agent's holding is down by the commission: MAD 50,000 − 30,000.
  await page.goto('/ledgers/agents', { waitUntil: 'domcontentloaded' });
  const agent = page.getByRole('row').filter({ hasText: 'E2E Settlement Agent' }).first();
  await expect(agent).toContainText(/MAD 20,000\.00/, { timeout: 30_000 });

  // And the dashboard's card opens this ledger.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('outstanding-unpaid-expenses');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  await page.waitForURL(/\/finance\/unpaid-expenses/, { waitUntil: 'domcontentloaded' });
  console.log(`  ${RUN}: booked 3, settled by bank+cash, set-off and cheque; ledger and agent agree after reload`);
});
