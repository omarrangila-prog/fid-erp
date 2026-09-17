import { test, expect, type Page } from '@playwright/test';

/**
 * The shipments list states cost per kilo in both currencies.
 *
 * Read-only. The landed column has always shown USD over the local amount;
 * the cost per kilo beside it is the figure a trader reads most often, and it
 * has to be readable in the money they actually buy and sell in.
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

test('cost per kilo shows the local currency alongside USD', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);

  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // A data row, not the header: header cells contain the word USD too.
  const rows = main.getByRole('row').filter({ hasText: /USD\s*[\d,]+\.\d{2}/ });
  if ((await rows.count()) === 0) {
    test.skip(true, 'No costed shipment in this company.');
    return;
  }

  const row = rows.first();
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  console.log('\nshipment row:', text);

  // Landed has always carried both; cost per kilo must now do the same.
  expect(text, 'the row should state a USD cost per kilo').toMatch(/USD\s*[\d,]+\.\d{2}/);
  expect(text, 'the row should state the same cost in the local currency').toMatch(/MAD\s*[\d,]+\.\d{2}/);
  // Per tonne, in both, on the same line.
  expect(text, 'per-tonne should be stated in both currencies').toMatch(/MAD\s*[\d,]+\.\d{2}\s*\/\s*MT/);
});
