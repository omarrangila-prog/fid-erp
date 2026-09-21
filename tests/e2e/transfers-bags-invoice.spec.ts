import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The three things fixed together, checked in the browser:
 *
 *   a warehouse transfer is numbered WTO-001, WTO-002 … by the server
 *   Stock on Hand never shows negative bags beside positive kilograms
 *   one invoice can sell each item from its own warehouse
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('a new transfer shows the next WTO number, and the list carries it', async ({ page }) => {
  await page.goto('/inventory/transfers/new', { waitUntil: 'domcontentloaded' });
  const number = page.getByLabel('Transfer No.');
  if ((await number.count()) === 0) {
    // One warehouse, or no stock: the screen explains what is missing instead.
    await expect(page.getByText(/Before you can transfer stock|Two warehouses are needed/i).first()).toBeVisible({ timeout: 30_000 });
    test.skip(true, 'This fixture has nothing to transfer.');
    return;
  }
  await expect(number).toHaveValue(/^WTO-\d{3,}$/, { timeout: 30_000 });
  await expect(number).toHaveAttribute('readonly', '');
  const issued = await number.inputValue();

  // Move one kilogram of the first batch the source warehouse holds.
  const batch = page.getByRole('combobox').filter({ hasText: /Choose a batch/ }).first();
  await batch.click();
  await page.getByRole('listbox').locator('[role="option"]:not([disabled])').first().click();
  await page.locator('main input[inputmode="decimal"]').first().fill('1');
  await page.getByRole('button', { name: /^Create transfer$/ }).click();
  await page.waitForURL(/\/inventory\/transfers$/, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  await expect(page.getByRole('columnheader', { name: 'Transfer No.' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: issued }).first()).toBeVisible();
  console.log(`  transfer saved as ${issued}`);
});

test('Stock on Hand shows bags that follow the kilograms, never negative', async ({ page }) => {
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  const table = page.getByRole('table').first();
  await expect(table).toBeVisible({ timeout: 45_000 });

  const headers = (await table.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const bagsAt = headers.findIndex((h) => /^Bags/i.test(h));
  const onHandAt = headers.findIndex((h) => /^On hand/i.test(h));
  expect(bagsAt, `columns: ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);

  const rows = await table.locator('tbody tr').all();
  let checked = 0;
  for (const row of rows) {
    const cells = await row.locator('td').allTextContents();
    if (cells.length <= bagsAt) continue;
    const bags = Number(cells[bagsAt].replace(/[^\d.-]/g, ''));
    const kg = onHandAt >= 0 ? Number(cells[onHandAt].replace(/[^\d.-]/g, '')) : NaN;
    expect(bags, `row: ${cells.join(' | ')}`).toBeGreaterThanOrEqual(0);
    if (!Number.isNaN(kg) && kg > 0) expect(bags).toBeGreaterThan(0);
    checked += 1;
  }
  expect(checked).toBeGreaterThan(0);
  console.log(`  ${checked} stock rows, no negative bag count`);
});

test('each invoice item chooses its own warehouse, with no warehouse on the header', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  const first = page.getByLabel('Warehouse on item 1');
  const second = page.getByLabel('Warehouse on item 2');
  await expect(first).toBeVisible({ timeout: 45_000 });
  await expect(second).toBeVisible();

  // No invoice-wide warehouse to clash with the lines: each item names its own.
  await expect(page.locator('#warehouseId')).toHaveCount(0);
  await expect(page.getByText('Default warehouse')).toHaveCount(0);
  const offered = (await first.locator('option').allTextContents()).filter((o) => !/Choose/i.test(o));
  expect(offered.length).toBeGreaterThan(0);
  await first.selectOption({ index: 1 });

  // Choose coffee on item 1, then move item 2 to another warehouse: item 1 keeps its choice.
  await page.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  const firstWarehouse = await first.inputValue();
  if (offered.length > 1) {
    await second.selectOption({ index: 2 });
    expect(await second.inputValue()).not.toBe(firstWarehouse);
    await expect(first).toHaveValue(firstWarehouse);
    await page.getByRole('combobox', { name: /Coffee on item 2/ }).click();
    await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    console.log(`  item 1 from one warehouse, item 2 from another (${offered.length} offered)`);
  } else {
    console.log('  one warehouse with stock in this fixture; each item still carries its own picker');
  }
});
