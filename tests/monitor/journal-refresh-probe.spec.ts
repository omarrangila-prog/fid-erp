import { test, expect, type Page } from '@playwright/test';

/**
 * What a refresh does to a half-typed journal voucher.
 *
 * Read-only: it types into the form and reloads, and never posts. The thing
 * worth knowing is whether the browser restores the typed amounts into the
 * inputs while React's own state starts empty — a form that looks filled but
 * is not is far worse on a financial screen than one that is plainly blank.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  await expect(tile).toBeVisible({ timeout: 60_000 });
  await tile.click();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  if (!(await keypad.isVisible().catch(() => false))) {
    await page.waitForTimeout(2_000);
    await tile.click();
  }
  await expect(keypad).toBeVisible({ timeout: 30_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
}

test('a refreshed journal voucher is either honestly empty or honestly full', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);

  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  await expect(main).toBeVisible({ timeout: 30_000 });

  /*
   * The screen opens by asking what happened; the free-form voucher this probe
   * is about is one button on. Production is served from Tokyo and the click
   * can land before React has hydrated, in which case nothing happens — so
   * press it until the form is actually open.
   */
  const openAdvanced = async () => {
    const advanced = main.getByRole('button', { name: /advanced journal entry/i });
    const box = main.getByLabel(/^memo/i);
    // Either the voucher is already open, or the chooser is on screen and the
    // button has to be pressed — and on a cold page neither has rendered yet,
    // so this keeps looking rather than deciding on the first glance.
    await expect(async () => {
      if (await box.count()) return;
      if (await advanced.count()) await advanced.click();
      await expect(box).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
  };
  await openAdvanced();
  const memoBox = main.getByLabel(/^memo/i);

  await memoBox.fill('Refresh probe — never posted');
  await main.getByLabel(/line 1 amount/i).fill('123.45');
  await main.getByRole('combobox', { name: /line 1 account/i }).click();
  // The list leads with a heading rendered as a disabled option; take the
  // first account that can actually be chosen.
  await page.getByRole('listbox').locator('[role="option"]:not([disabled])').first().click();

  const accountBefore = await main.getByRole('combobox', { name: /line 1 account/i }).innerText();
  console.log('\nbefore refresh');
  console.log('  memo        :', await main.getByLabel(/^memo/i).inputValue());
  console.log('  amount      :', await main.getByLabel(/line 1 amount/i).inputValue());
  console.log('  account     :', accountBefore.replace(/\s+/g, ' ').trim());

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(main).toBeVisible({ timeout: 30_000 });
  // A refresh returns to the chooser; the voucher underneath is what this
  // probe is about, so open it again and read what it kept.
  await openAdvanced();
  await page.waitForTimeout(2_000);

  const memo = await main.getByLabel(/^memo/i).inputValue();
  const amount = await main.getByLabel(/line 1 amount/i).inputValue();
  const account = (await main.getByRole('combobox', { name: /line 1 account/i }).innerText()).replace(/\s+/g, ' ').trim();
  const balanced = await main.getByText(/^balanced$/i).count();
  const notBalanced = await main.getByText(/not balanced/i).count();

  console.log('after refresh');
  console.log('  memo        :', JSON.stringify(memo));
  console.log('  amount      :', JSON.stringify(amount));
  console.log('  account     :', JSON.stringify(account));
  console.log('  balanced?   :', balanced ? 'says balanced' : notBalanced ? 'says NOT balanced' : 'says neither');

  // The dangerous combination: inputs still show figures while the account
  // picker has forgotten what was chosen, so the screen is not what posts.
  const inputsKept = Boolean(memo || amount);
  const accountKept = !/choose an account/i.test(account);
  expect(
    inputsKept === accountKept,
    `after a refresh the amounts ${inputsKept ? 'were kept' : 'were cleared'} but the account ${accountKept ? 'was kept' : 'was cleared'} — the screen would not match what posts`,
  ).toBe(true);
});
