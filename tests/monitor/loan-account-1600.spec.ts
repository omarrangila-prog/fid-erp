import { test, expect, type Page } from '@playwright/test';

/**
 * The account the client keeps for the other company shows the debt.
 *
 * Read-only. It opens the general ledger on "1600 · F I D TRADING LLC DUBAI"
 * and the loan form, and reports what a person would see. It clicks nothing
 * that writes.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = 'FID Trading International SARL';

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

test('1600 shows what Morocco owes Dubai', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  // The account picker is a custom component, so the account is named in the
  // URL the way the picker itself names it.
  const accountId = process.env.MONITOR_LEDGER_ACCOUNT_ID;
  if (!accountId) throw new Error('Set MONITOR_LEDGER_ACCOUNT_ID to the 1600 account id.');
  await page.goto(`/reports/general-ledger?account=${accountId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByText(/F I D TRADING LLC DUBAI/i).first()).toBeVisible({ timeout: 45_000 });

  const body = (await page.locator('body').textContent()) ?? '';
  console.log('  shows the loan entry:', /Loan from FID Trading/i.test(body));
  console.log('  shows 50,000:', /50[,\s.]?000/.test(body));
  console.log('  still says "no movements":', /No movements on this account/i.test(body));

  expect(body).not.toMatch(/No movements on this account/i);
  expect(body).toMatch(/50[,\s.]?000/);
});

test('the loan form offers 1600 and has an empty memo box', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await signIn(page);

  await page.goto('/finance/intercompany-loan', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/This is a loan, not a transfer/i)).toBeVisible({ timeout: 45_000 });

  const options = await page.locator('select option').allTextContents();
  console.log('  1600 offered as a loan account:', options.some((o) => /1600/.test(o)));
  expect(options.some((o) => /1600/.test(o))).toBe(true);

  const memo = page.locator('input').filter({ hasNot: page.locator('[type=date]') });
  const placeholders = await memo.evaluateAll((els) =>
    els.map((el) => (el as HTMLInputElement).placeholder).filter(Boolean),
  );
  console.log('  placeholders on the form:', placeholders.join(' | ') || '(none)');
  expect(placeholders.join(' ')).not.toMatch(/Working capital|Loan from FID Trading International/i);
});
