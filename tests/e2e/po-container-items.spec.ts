import { test, expect, type Page } from '@playwright/test';

/**
 * One container, two coffees — entered the way the client enters a
 * purchase order.
 *
 * "+ Add Item to This Container" puts a second coffee in the same box, and the
 * order, once approved, reads one container. Editing the approved order and
 * adding a third coffee to that container still reads one container; adding a
 * container makes two.
 */
const ADMIN_PIN = process.env.ADMIN_PIN;
const MOROCCO = /FID Trading International SARL/i;
const REFERENCE = `E2E/BOX/${Date.now().toString(36).toUpperCase()}`;
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the container tests.');
test.describe.configure({ mode: 'serial' });

let orderUrl = '';

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of ADMIN_PIN!.split('')) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
  const switcher = page.getByRole('button', { name: /FID / }).first();
  if (await switcher.count()) {
    if (!MOROCCO.test((await switcher.textContent()) ?? '')) {
      await switcher.click();
      await page.getByRole('menuitem', { name: MOROCCO }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

async function fillItem(page: Page, item: ReturnType<Page['locator']>, option: number, kg: string) {
  // The coffee picker, not the native "move to container" select beside it.
  await item.locator('[role="combobox"]:not(select)').first().click();
  await page.getByRole('listbox').getByRole('option').nth(option).click();
  await item.getByLabel(/^Quantity/).fill(kg);
  await item.getByRole('textbox', { name: /Rate per unit|Price per unit/ }).fill('2.5');
}

test('one container with two coffees is saved as one container', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  await page.locator('#contractReference').fill(REFERENCE);
  const supplier = page.locator('#vendorId');
  await expect(supplier).toBeVisible({ timeout: 30_000 });
  await supplier.click();
  await page.getByRole('listbox').getByRole('option').first().click();

  const box = page.getByTestId('po-container').first();
  await fillItem(page, box.getByTestId('po-item').nth(0), 0, '12000');
  await box.getByLabel(/^Container number/).fill(`BOXU${Date.now().toString().slice(-7)}`);
  // A second coffee in the SAME container.
  await box.getByTestId('po-add-item').click();
  await expect(box.getByTestId('po-item')).toHaveCount(2);
  await fillItem(page, box.getByTestId('po-item').nth(1), 1, '8000');

  await expect(page.getByTestId('po-container')).toHaveCount(1);
  await expect(page.getByTestId('po-container-count')).toHaveValue('1');
  await expect(box.getByTestId('po-container-summary')).toContainText('2 items');

  await page.getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  orderUrl = page.url();
  await expect(page.getByText(/^1 container on this order$/)).toBeVisible({ timeout: 45_000 });
});

test('adding a coffee to that container keeps one container; adding a container makes two', async ({ page }) => {
  test.setTimeout(240_000);
  test.skip(!orderUrl, 'No order saved');
  await signIn(page);
  await page.goto(`${orderUrl}/edit`, { waitUntil: 'domcontentloaded' });

  const box = page.getByTestId('po-container').first();
  await expect(box.getByTestId('po-item')).toHaveCount(2, { timeout: 45_000 });
  await box.getByTestId('po-add-item').click();
  await fillItem(page, box.getByTestId('po-item').nth(2), 0, '1000');
  await expect(page.getByTestId('po-container-count')).toHaveValue('1');
  await page.getByRole('button', { name: /^Save correction$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save correction$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByText(/^1 container on this order$/)).toBeVisible({ timeout: 45_000 });

  await page.goto(`${orderUrl}/edit`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('po-item')).toHaveCount(3, { timeout: 45_000 });
  await page.getByTestId('po-add-container').click();
  const second = page.getByTestId('po-container').nth(1);
  await fillItem(page, second.getByTestId('po-item').nth(0), 1, '5000');
  await expect(page.getByTestId('po-container-count')).toHaveValue('2');
  await page.getByRole('button', { name: /^Save correction$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save correction$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByText(/^2 containers on this order$/)).toBeVisible({ timeout: 45_000 });
});
