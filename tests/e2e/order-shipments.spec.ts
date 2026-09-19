import { test, expect, type Page } from '@playwright/test';

/**
 * One purchase order, three shipments — the client's own case, in the browser.
 *
 * The order ICUL/FID/… is entered once with three lines, one container each,
 * each with its own lot and batch. Three shipments open under it. The first
 * lands and the order reads "1 of 3 arrived"; the second lands and it reads
 * "2 of 3"; the third is marked from the order itself and it reads fully
 * arrived. Then all three are received in one receipt, and the stock, the
 * batches, the items and the loading sheet each show three separate lines
 * under the one reference — 60,000 KG in total, never 180,000.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the order walkthrough.');

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const STAMP = Date.now().toString().slice(-5);
const REFERENCE = `ICUL/FID/E2E-${STAMP}`;
const LINES = [
  { container: `CONT-${STAMP}-1`, lot: `LOT-${STAMP}-1`, batch: `BATCH-${STAMP}-1`, kg: '20000', price: '4.116' },
  { container: `CONT-${STAMP}-2`, lot: `LOT-${STAMP}-2`, batch: `BATCH-${STAMP}-2`, kg: '21000', price: '3.998' },
  { container: `CONT-${STAMP}-3`, lot: `LOT-${STAMP}-3`, batch: `BATCH-${STAMP}-3`, kg: '19000', price: '4.25' },
];

let orderUrl = '';

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first().click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }

  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!MOROCCO.test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: MOROCCO }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

/** The card for one line on the purchase order form. */
function lineCard(page: Page, n: number) {
  return page.locator('div.rounded-xl.p-4').filter({ has: page.getByText(`Line ${n}`, { exact: true }) });
}

/** The row on the loading sheet for one shipment of this order. */
function sheetRow(page: Page, ordinal: number) {
  return page
    .getByRole('row')
    .filter({ hasText: REFERENCE })
    .filter({ hasText: new RegExp(`Shipment ${ordinal} of 3`) })
    .first();
}

/** Mark one shipment loaded then arrived, the way the loading sheet does it. */
async function landShipment(page: Page, ordinal: number) {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const row = sheetRow(page, ordinal);
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole('button', { name: /Mark loaded/i }).first().click();
  await expect(page.getByLabel(/loading date/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/estimated arrival/i).fill('2026-09-20');
  const shippingLine = page.getByLabel(/shipping line/i);
  await shippingLine.selectOption({ index: 1 });
  await page.getByLabel(/booking number/i).fill(`BK-${STAMP}-${ordinal}`);
  await page.getByRole('button', { name: /^Mark as loaded$/i }).click();
  await expect(page.getByLabel(/loading date/i)).toHaveCount(0, { timeout: 30_000 });

  await page.waitForLoadState('networkidle').catch(() => undefined);
  const loaded = sheetRow(page, ordinal);
  await expect(loaded).toContainText(/Loaded/i, { timeout: 30_000 });

  // The sheet re-renders once the server confirms the load, so wait for the
  // arrive control to be there rather than counting it at one instant.
  const arrive = sheetRow(page, ordinal).getByRole('button', { name: /Mark arrived/i }).first();
  await expect(arrive).toBeVisible({ timeout: 30_000 });
  await arrive.click();
  await expect(page.getByLabel(/arrived on/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Mark as arrived$/i }).click();
  await expect(page.getByLabel(/arrived on/i)).toHaveCount(0, { timeout: 30_000 });
}

test('one purchase order is entered with three containers, lots and batches', async ({ page }) => {
  await signIn(page);
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.locator('#contractReference').fill(REFERENCE);

  const supplier = page.locator('#vendorId');
  await expect(supplier).toBeVisible({ timeout: 30_000 });
  await supplier.click();
  await page.getByRole('listbox').getByRole('option').first().click();

  await page.locator('#containers').fill('3');

  for (const [index, line] of LINES.entries()) {
    const n = index + 1;
    if (n > 1) await page.getByRole('button', { name: /^Add line$/ }).click();
    const card = lineCard(page, n);
    await expect(card).toBeVisible();

    await card.getByRole('combobox').first().click();
    await page.getByRole('listbox').getByRole('option').first().click();

    await card.getByLabel(/^Quantity/).fill(line.kg);
    await card.getByRole('textbox', { name: /Rate per unit|Price per unit/ }).fill(line.price);

    await card.getByText(/Lot, batch, container and packing/).click();
    await card.getByLabel(/lot number/i).fill(line.lot);
    await card.getByLabel(/batch number/i).fill(line.batch);
    await card.getByLabel(/container number/i).fill(line.container);
  }

  await page.getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  orderUrl = page.url();

  await expect(page.getByText(/3 shipments on this order/)).toBeVisible({ timeout: 45_000 });
  const main = (await page.locator('main').textContent()) ?? '';
  expect(main).toMatch(/0 of 3 arrived/);
  expect(main).toMatch(/Not arrived/);
  for (const line of LINES) {
    expect(main).toContain(line.container);
    expect(main).toContain(line.lot);
    expect(main).toContain(line.batch);
  }
  expect(main).toMatch(/Shipment 1[\s\S]*Shipment 2[\s\S]*Shipment 3/);
  // The order total is the lines added up, once.
  expect(main).toMatch(/60,000/);
  expect(main).not.toMatch(/180,000/);
  console.log(`  order ${REFERENCE} saved with 3 shipments`);
});

test('the first shipment lands and the order reads 1 of 3 arrived', async ({ page }) => {
  await signIn(page);
  await landShipment(page, 1);

  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/1 of 3 arrived/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Partially arrived/).first()).toBeVisible();
});

test('the second lands and it reads 2 of 3, still partial', async ({ page }) => {
  await signIn(page);
  await landShipment(page, 2);

  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/2 of 3 arrived/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Partially arrived/).first()).toBeVisible();
});

test('the last is marked from the order itself, and the order is fully arrived', async ({ page }) => {
  await signIn(page);
  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByRole('button', { name: /Mark all arrived/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Mark all 1 shipment under/);
  await dialog.getByRole('button', { name: /^Mark all arrived$/ }).click();

  await expect(page.getByText(/3 of 3 arrived/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Fully arrived/).first()).toBeVisible();
  // The button stays, greyed out, so nobody wonders where it went.
  await expect(page.getByRole('button', { name: /Mark all arrived/i })).toBeDisabled();
});

test('all three are received in one receipt, into stock, separately', async ({ page }) => {
  await signIn(page);
  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByRole('button', { name: /Receive goods/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // Every shipment on the order is offered together, each named by its place.
  const offered = (await dialog.textContent()) ?? '';
  expect(offered).toMatch(/Shipment 1/);
  expect(offered).toMatch(/Shipment 2/);
  expect(offered).toMatch(/Shipment 3/);
  for (const line of LINES) expect(offered).toContain(line.container);

  const warehouse = dialog.getByLabel(/warehouse/i).first();
  if ((await warehouse.locator('option').count()) > 1) await warehouse.selectOption({ index: 1 });
  await dialog.getByRole('button', { name: /^Receive into stock$/i }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });

  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByText(/3 of 3 received/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Fully received/).first()).toBeVisible();
});

test('stock, batches, items and the loading sheet each show three lines under the one reference', async ({ page }) => {
  await signIn(page);

  // Batch stock: three batches, each with its lot, container and place on the order.
  await page.goto('/inventory/batches', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const batchesText = (await page.locator('main').textContent()) ?? '';
  for (const line of LINES) expect(batchesText).toContain(line.batch);
  expect(batchesText).toMatch(/Shipment 1 of 3/);
  expect(batchesText).toMatch(/Shipment 3 of 3/);

  // Stock on hand: the row for this order's coffee opens into its three
  // batches, each with its own container and lot.
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  const stockRow = page.getByRole('row').filter({ hasText: REFERENCE }).first();
  await expect(stockRow).toBeVisible({ timeout: 30_000 });
  await stockRow.getByRole('button', { name: /Show detail/i }).click({ timeout: 15_000 });
  await expect(page.getByText(/batches behind this stock/).first()).toBeVisible({ timeout: 15_000 });
  const stockText = (await page.locator('main').textContent()) ?? '';
  expect(stockText).toContain(REFERENCE);
  for (const line of LINES) {
    expect(stockText).toContain(line.container);
    expect(stockText).toContain(line.lot);
  }

  // Shipments: three rows, each "Shipment n of 3" of this order.
  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const shipmentsText = (await page.locator('main').textContent()) ?? '';
  expect(shipmentsText).toMatch(/Shipment 1 of 3/);
  expect(shipmentsText).toMatch(/Shipment 2 of 3/);
  expect(shipmentsText).toMatch(/Shipment 3 of 3/);

  // Loading sheet: the same, with the reference on each.
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  for (const ordinal of [1, 2, 3]) await expect(sheetRow(page, ordinal)).toBeVisible({ timeout: 30_000 });

  // Purchase list: the parent row says arrived, and opens into its children.
  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  const orderRow = page.getByRole('row').filter({ hasText: REFERENCE }).first();
  await expect(orderRow).toBeVisible({ timeout: 30_000 });
  await expect(orderRow).toContainText(/Fully arrived/);
  await orderRow.getByRole('button', { name: /Show detail/i }).click({ timeout: 15_000 });
  await expect(page.getByText(/The 3 shipments on this order/).first()).toBeVisible({ timeout: 15_000 });
  const listText = (await page.locator('main').textContent()) ?? '';
  expect(listText).toMatch(/The 3 shipments on this order/);
  for (const line of LINES) expect(listText).toContain(line.container);

  // And nowhere along the way did a system code appear.
  for (const text of [batchesText, stockText, shipmentsText, listText]) {
    expect(text).not.toMatch(/FID-MA-(PO|SHP|JOB|GRN|SI)-\d{6}/);
  }
  console.log('  three shipments visible on batches, stock, shipments, loading sheet and the order list');
});
