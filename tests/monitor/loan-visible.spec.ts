import { test, expect, type Page } from '@playwright/test';

/**
 * Is the loan there, on the screens the client actually opens?
 *
 * Read-only. It signs in, looks at Cash & Bank, the general journal and both
 * loan ledgers, and reports what a person sitting in front of the application
 * would see. It clicks nothing that writes.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, company: string) {
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
    await page.getByRole('button', { name: new RegExp(company, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!new RegExp(company, 'i').test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: new RegExp(company, 'i') }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

test('Morocco sees the money arrive and the debt it owes', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page, 'FID Trading International SARL');

  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/ATIJJARI BANK/i).first()).toBeVisible({ timeout: 45_000 });
  const cash = (await page.locator('body').textContent()) ?? '';
  console.log('  Cash & Bank shows 461,000:', /461[,\s.]?000/.test(cash));
  expect(cash).toMatch(/461[,\s.]?000/);

  await page.goto('/reports/journal', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const journal = (await page.locator('body').textContent()) ?? '';
  console.log('  Journal shows the loan entry:', /Loan from FID Trading/i.test(journal));
  expect(journal).toMatch(/Loan from FID Trading/i);
});

test('Dubai sees the money leave and the debt it is owed', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page, 'FID Trading L.L.C.');

  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/USD Bank Account/i).first()).toBeVisible({ timeout: 45_000 });
  const cash = (await page.locator('body').textContent()) ?? '';
  console.log('  Cash & Bank shows 50,000 out:', /50[,\s.]?000/.test(cash));
  expect(cash).toMatch(/50[,\s.]?000/);

  await page.goto('/reports/journal', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const journal = (await page.locator('body').textContent()) ?? '';
  console.log('  Journal shows the loan entry:', /Loan from FID Trading/i.test(journal));
  expect(journal).toMatch(/Loan from FID Trading/i);
});

test('the loan screen offers no AED account and asks for a memo', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page, 'FID Trading International SARL');

  await page.goto('/finance/intercompany-loan', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/This is a loan, not a transfer/i)).toBeVisible({ timeout: 45_000 });

  // The two bank dropdowns specifically — the "which account carries the
  // debt" lists next to them are ledger accounts, not banks, and are checked
  // on their own terms elsewhere.
  for (const label of ['From account', 'To account']) {
    const options = await page.getByLabel(label).locator('option').allTextContents();
    const aed = options.filter((o) => /\bAED\b/.test(o));
    console.log(`  ${label}: ${options.join(' | ')}`);
    expect(aed, `${label} offers AED`).toHaveLength(0);
  }

  // And no cash or bank account is offered as a place to carry the debt.
  for (const label of ['Record what they are owed in', 'Record what they owe in']) {
    const options = await page.getByLabel(label).locator('option').allTextContents();
    const cash = options.filter((o) => /cash in hand|bank account/i.test(o));
    console.log(`  ${label}: ${options.join(' | ')}`);
    expect(cash, `${label} offers a cash or bank account`).toHaveLength(0);
  }

  await expect(page.getByText('Memo', { exact: true })).toBeVisible({ timeout: 20_000 });
});
