import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Delete Shipment — one action; the system undoes what it must.
 *
 *   1. Three containers, nothing received: deleted from the Loading Sheet;
 *      the row goes, the purchase order stays as a draft.
 *   2. One container received into stock: deleted from the shipment page;
 *      the goods receipt is reversed by the delete itself, the coffee leaves
 *      stock, and nobody reverses anything by hand.
 *   3. A shipment whose coffee has been sold: the window says why it cannot
 *      go, links to the sale, and the button stays off.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const STAMP = Date.now().toString().slice(-5);
const PLAIN = { reference: `ICUL/FID/DEL3-${STAMP}`, containers: [1, 2, 3].map((n) => `DLCU${STAMP}0${n}`) };
const RECEIVED = { reference: `ICUL/FID/DELR-${STAMP}`, containers: [`DLRU${STAMP}01`] };

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible({ timeout: 45_000 });
  for (const digit of ADMIN_PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (page.url().includes('select-company')) {
    await chooseCompany(page, /FID Trading International SARL/);
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

function lineCard(page: Page, n: number) {
  return page.locator('div.rounded-xl.p-4').filter({ has: page.getByText(`Container ${n}`, { exact: true }) });
}

async function createOrder(page: Page, reference: string, containers: string[]) {
  const n = containers.length;
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.locator('#contractReference').fill(reference);
  const supplier = page.locator('#vendorId');
  await expect(supplier).toBeVisible({ timeout: 30_000 });
  await supplier.click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.locator('#containers').fill(String(n));
  const first = lineCard(page, 1);
  await first.getByRole('combobox').first().click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await first.getByLabel(/^Quantity/).fill(String(20000 * n));
  await first.getByRole('textbox', { name: /Rate per unit|Price per unit/ }).fill('4.5');
  if (n > 1) {
    await first.getByLabel(/Split into containers/).fill(String(n));
    await first.getByRole('button', { name: new RegExp(`^Split into ${n}$`) }).click();
    await expect(lineCard(page, n)).toBeVisible();
  }
  for (const [i, container] of containers.entries()) {
    const card = lineCard(page, i + 1);
    await card.getByText(/Lot, batch, container and packing/).click();
    await card.getByLabel(/lot number/i).fill(`L-${container}`);
    await card.getByLabel(/batch number/i).fill(`B-${container}`);
    await card.getByLabel(/container number/i).fill(container);
  }
  await page.getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByText(new RegExp(`${n} containers? on this order`))).toBeVisible({ timeout: 45_000 });
}

async function sheetRow(page: Page, reference: string) {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const row = page.getByRole('row').filter({ hasText: reference }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  return row;
}

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await signIn(page);
});
test.afterAll(async () => page?.context().close());

test('a shipment with nothing received is deleted from the Loading Sheet; its order stays as a draft', async () => {
  await createOrder(page, PLAIN.reference, PLAIN.containers);
  const row = await sheetRow(page, PLAIN.reference);
  await row.getByRole('button', { name: /More actions/i }).click();
  await page.getByRole('menuitem', { name: /Delete shipment/ }).click();

  const dialog = page.getByTestId('delete-shipment');
  await expect(dialog.getByTestId('delete-safe')).toBeVisible({ timeout: 45_000 });
  await expect(dialog.locator('[data-related="Containers"]')).toContainText('3');
  await dialog.getByLabel('Reason').selectOption('Duplicate shipment');
  await page.getByTestId('confirm-delete-shipment').click();
  await expect(page.getByText(/Shipment .* deleted\. Its purchase order is kept as a draft/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('row').filter({ hasText: PLAIN.reference })).toHaveCount(0, { timeout: 45_000 });

  // The order is still there, as a draft with its three containers.
  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  const order = page.getByRole('row').filter({ hasText: PLAIN.reference }).first();
  await expect(order).toBeVisible({ timeout: 45_000 });
  await expect(order).toContainText(/Draft/i);
});

test('a received shipment is deleted from its page: the receipt is reversed for you and the coffee leaves stock', async () => {
  await createOrder(page, RECEIVED.reference, RECEIVED.containers);

  // Arrive and receive it, from the Loading Sheet.
  const row = await sheetRow(page, RECEIVED.reference);
  await row.getByTestId('quick-update-open').click();
  const panel = page.getByTestId('quick-update');
  const container = panel.locator(`tr[data-container="${RECEIVED.containers[0]}"]`);
  await expect(container).toBeVisible({ timeout: 45_000 });
  await container.getByRole('button', { name: /Mark arrived/ }).click();
  await container.getByRole('button', { name: /^Save$/ }).click();
  await expect(panel.locator('[data-summary="arrival"]')).toHaveText('1 / 1 Arrived', { timeout: 45_000 });
  await container.getByRole('button', { name: /^Receive$/ }).click();
  await page.getByRole('button', { name: /^Receive (all|selected \(1\))$/ }).click();
  await expect(panel.locator('[data-summary="receipt"]')).toHaveText('1 / 1 Received', { timeout: 60_000 });
  const shipmentHref = (await container.getByRole('link', { name: /Open/ }).getAttribute('href')) ?? '';
  await page.keyboard.press('Escape');

  // In stock now.
  await page.goto('/inventory/batches', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(`B-${RECEIVED.containers[0]}`, { timeout: 45_000 });

  // Delete from the shipment page: one red button.
  await page.goto(shipmentHref, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('delete-shipment-button').click();
  const dialog = page.getByTestId('delete-shipment');
  await expect(dialog.getByTestId('delete-safe')).toContainText(/Goods receipt .* reversed/, { timeout: 45_000 });
  await dialog.getByText('Delete it too').click();
  await dialog.getByLabel('Reason').selectOption('Test entry');
  await dialog.getByLabel('Memo').fill('received into the wrong order');
  await page.getByTestId('confirm-delete-shipment').click();
  await page.waitForURL(/\/loading$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.getByRole('row').filter({ hasText: RECEIVED.reference })).toHaveCount(0, { timeout: 45_000 });

  // Out of stock, and the receipt reads as reversed — nobody reversed it by hand.
  await page.goto('/inventory/batches', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).not.toContainText(`B-${RECEIVED.containers[0]}`, { timeout: 45_000 });
  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('row').filter({ hasText: RECEIVED.reference })).toHaveCount(0, { timeout: 45_000 });
});

test('a shipment whose coffee has been sold says why it cannot go, and links to the sale', async () => {
  const row = await sheetRow(page, 'E2E-PO-MA-1');
  await row.getByRole('button', { name: /More actions/i }).click();
  await page.getByRole('menuitem', { name: /Delete shipment/ }).click();
  const dialog = page.getByTestId('delete-shipment');
  await expect(dialog.getByTestId('delete-blocked')).toContainText(/sold on \d+ sales invoice/, { timeout: 45_000 });
  await expect(dialog.getByTestId('delete-dependencies').getByRole('link', { name: /View sale/ }).first()).toBeVisible();
  await expect(page.getByTestId('confirm-delete-shipment')).toBeDisabled();
  await page.getByRole('button', { name: /^Cancel$/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'E2E-PO-MA-1' }).first()).toBeVisible();
});
