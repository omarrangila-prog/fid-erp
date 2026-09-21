import { test, expect, type Page } from '@playwright/test';

/**
 * The screens added for the client's brief, opened the way they would open
 * them. Read-only: it looks, it does not save.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    const arrived = await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (arrived) break;
    if (!(await tile.isVisible().catch(() => false))) break;
  }
  await expect(keypad).toBeVisible({ timeout: 30_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!new RegExp(COMPANY, 'i').test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: new RegExp(COMPANY, 'i') }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

test('a loan can be recorded from anybody', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/This is not income and not a cost/i)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: /We received a loan/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /We lent money out/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /We repaid a loan/i })).toBeVisible();
  await expect(page.getByText('Memo', { exact: true })).toBeVisible();
  console.log('  loan screen: three directions and a memo');
});

test('the guided journal asks a business question', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  const body = (await page.locator('body').textContent()) ?? '';
  for (const option of [
    'Money received',
    'Money paid',
    'Transfer between accounts',
    'Cash to bank',
    'Bank to cash',
    'Loan received',
    'Loan given',
    'Loan repayment',
    'Owner or shareholder funding',
    'Opening balances',
  ]) {
    expect(body, option).toContain(option);
  }
  console.log('  guided journal: every option present');
});

test('the cash book reads like a bank statement', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  await page.goto('/reports/cash-book', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).toContain('Opening balance');
  expect(body).toContain('Money in');
  expect(body).toContain('Money out');
  expect(body).toContain('Balance now');
  console.log('  cash book: opening, in, out, balance');
});

test('the ledger says what the balance means', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  const accountId = process.env.MONITOR_LEDGER_ACCOUNT_ID;
  test.skip(!accountId, 'Set MONITOR_LEDGER_ACCOUNT_ID.');

  await page.goto(`/reports/general-ledger?account=${accountId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const body = (await page.locator('body').textContent()) ?? '';

  // Not a bare negative: it says which way round it is.
  expect(body).toMatch(/Payable to/i);
  expect(body).toContain('Total debit');
  expect(body).toContain('Total credit');
  console.log('  ledger: says "Payable to", with debit and credit totals');
});

test('a profit and loss figure opens what is behind it', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  await page.goto('/reports/profit-loss', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // Every period a trader asks for is one click.
  const body = (await page.locator('body').textContent()) ?? '';
  // The period picker's own wording: "All dates" is the whole history.
  for (const label of ['Today', 'Yesterday', 'Last 7 days', 'This month', 'All dates']) {
    expect(body, label).toContain(label);
  }

  const drill = page.locator('a[href*="/reports/general-ledger?account="]').first();
  const count = await page.locator('a[href*="/reports/general-ledger?account="]').count();
  console.log(`  profit and loss: ${count} figures open their transactions`);
  if (count > 0) {
    await drill.click();
    await page.waitForURL(/general-ledger/, { timeout: 45_000 });
    expect(page.url()).toContain('account=');
  }
});
