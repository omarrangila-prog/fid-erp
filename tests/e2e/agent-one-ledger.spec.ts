import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * One agent, one ledger — through the screens.
 *
 * E2E Ledger Agent holds MAD 50,000 of a customer's money (the fixture). Then:
 * his MAD 12,000 commission on the Moroccan order is booked on the expense
 * form, a loan each way is posted, he hands MAD 10,000 over, and the
 * commission is set off against what he still holds. Every one of those is a
 * single line on his ledger, in order, and still is after a reload.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const AGENT = 'E2E Ledger Agent';
const RUN = Date.now().toString(36).slice(-5);
const MEMO = `E2E ledger commission ${RUN}`;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first().click();
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

async function choose(page: Page, combobox: Locator, text?: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await combobox.click();
    if (text) await page.keyboard.type(text, { delay: 20 });
    const options = page.getByRole('listbox').getByRole('option');
    const option = text ? options.filter({ hasText: text }).first() : options.first();
    const shown = await option.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (shown && (await option.click({ timeout: 5_000 }).then(() => true).catch(() => false))) return;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  throw new Error('the picker never stayed open long enough to choose');
}

async function openLedger(page: Page) {
  await page.goto('/agents', { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('row').filter({ hasText: AGENT }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  const href = await row.getByRole('link', { name: 'Open ledger' }).getAttribute('href');
  expect(href).toMatch(/^\/agents\/[\w-]+$/);
  await page.goto(href!, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('agent-ledger')).toBeVisible({ timeout: 45_000 });
  return href!;
}

async function loan(page: Page, agentHref: string, what: RegExp, amount: string, into: RegExp) {
  await page.goto(`/finance/loans/new?agent=${agentHref.split('/').pop()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.getByRole('button', { name: what }).click();
  const agentChoice = page.getByRole('button', { name: 'An agent' });
  if (await agentChoice.count()) await agentChoice.click();
  await page.locator('#loanAgent').selectOption({ label: AGENT });
  const account = page.getByLabel(into).first();
  const value = await account.locator('option').filter({ hasText: /MAD|Cash|Bank/i }).nth(0).getAttribute('value');
  if (value) await account.selectOption(value);
  await page.getByLabel(/^Amount/).first().fill(amount);
  await page.getByRole('button', { name: /Post loan/ }).click();
  await page.waitForURL(/\/finance\/cash-bank/, { timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

let agentHref = '';

test('a commission booked on the shipment is one line on his ledger, with the shipment and the journal named', async ({ page }) => {
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByRole('main');
  await choose(page, form.getByRole('combobox', { name: /contract \/ shipment/i }), 'E2E-PO-MA-1');
  await choose(page, form.getByRole('combobox', { name: /expense category/i }));
  await form.getByLabel(/^Amount/).fill('12000');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('9.85');
  await form.getByLabel(/^Memo/).fill(MEMO);
  await choose(page, form.locator('#expensePayee'), 'E2E Ledger');
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  agentHref = await openLedger(page);
  const lines = page.getByTestId('agent-ledger').locator('tbody tr').filter({ hasText: MEMO });
  await expect(lines).toHaveCount(1);
  const line = lines.first();
  await expect(line).toContainText('E2E-PO-MA-1');
  await expect(line).toContainText(/JV \d+/);
  await expect(line).toContainText(/EXP \d+/);
  await expect(line).toContainText('Unpaid');
  // Standard columns: a commission owed to him is a credit on his ledger.
  await expect(line.getByTestId('agent-ledger-credit')).toHaveText('MAD 12,000.00');
  await expect(line.getByTestId('agent-ledger-debit')).toHaveText('—');
  // The collection the fixture recorded is there too, in his words.
  await expect(page.getByTestId('agent-ledger')).toContainText('Customer Collection');
});

test('a loan each way and a hand-over are each one line', async ({ page }) => {
  await loan(page, agentHref, /We received a loan/, '5000', /Received into/);
  await loan(page, agentHref, /We lent money out/, '3000', /Paid from/);

  await page.goto(agentHref, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('agent-received-open').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByLabel(/Paid into/i).selectOption({ index: 1 });
  await sheet.getByLabel(/^Amount/i).fill('10000');
  await sheet.getByRole('button', { name: /Record money received/i }).click();
  await expect(sheet).toHaveCount(0, { timeout: 30_000 });

  await page.goto(agentHref, { waitUntil: 'domcontentloaded' });
  const ledger = page.getByTestId('agent-ledger');
  await expect(ledger).toContainText(/Loan received from E2E Ledger Agent/, { timeout: 30_000 });
  await expect(ledger).toContainText(/Loan given to E2E Ledger Agent/);
  await expect(ledger).toContainText(/Agent settlement — money handed over/);
});

test('the commission set off against what he holds is one line that lowers both sides', async ({ page }) => {
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('row').filter({ hasText: MEMO }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByTestId('settle-expense').click();
  const dialog = page.getByTestId('settle-dialog');
  await dialog.getByRole('button', { name: /^Today$/ }).click();
  await dialog.getByLabel(/Ledger adjustment/).check();
  await page.getByTestId('post-settlement').click();
  await expect(page.getByText('Adjustment posted.').first()).toBeVisible({ timeout: 90_000 });

  await page.goto(agentHref, { waitUntil: 'domcontentloaded' });
  const setOff = page.getByTestId('agent-ledger').locator('tbody tr').filter({ hasText: 'Commission set-off' });
  await expect(setOff).toHaveCount(1, { timeout: 30_000 });
  // Commission payable debited and his collections credited: both sides, one line.
  await expect(setOff.first().getByTestId('agent-ledger-debit')).toHaveText('MAD 12,000.00');
  await expect(setOff.first().getByTestId('agent-ledger-credit')).toHaveText('MAD 12,000.00');
});

test('after a reload, all of it is one chronological ledger, and the dashboard opens it', async ({ page }) => {
  await page.goto(agentHref, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const ledger = page.getByTestId('agent-ledger');
  await expect(ledger).toBeVisible({ timeout: 45_000 });
  // The desktop table; the phone layout beside it is hidden but still on the page.
  const table = ledger.locator('table').first();
  const types = (await table.getByTestId('agent-ledger-type').allInnerTexts()).map((t) => t.trim());
  const at = (pattern: RegExp) => types.findIndex((t) => pattern.test(t));
  // The fixture's collection first; the rest in the order they were entered.
  expect(at(/Customer Collection/)).toBe(0);
  expect(at(/Commission set-off/)).toBeGreaterThan(at(/Agent settlement/));
  expect(types.filter((t) => /Commission set-off/.test(t))).toHaveLength(1);
  await expect(table.locator(':scope > tbody > tr').filter({ hasText: MEMO }).first()).toContainText('Settled');
  // Held 50,000 − 10,000 handed over − 12,000 set off, plus 3,000 lent to him; FID owes him the 5,000 loan.
  const position = (await page.getByTestId('agent-position').innerText()).replace(/\s+/g, ' ');
  expect(position).toMatch(/Collections held MAD 28,000\.00/);
  expect(position).toMatch(/Loan receivable MAD 3,000\.00/);
  expect(position).toMatch(/Loan payable MAD 5,000\.00/);

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('outstanding-agent').filter({ hasText: AGENT }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole('link', { name: 'Open agent ledger' }).click();
  await page.waitForURL(new RegExp(`${agentHref}$`), { timeout: 30_000 });
  console.log(`  ${RUN}: commission, collection, two loans, hand-over and set-off — one line each, in order, after a reload`);
});
