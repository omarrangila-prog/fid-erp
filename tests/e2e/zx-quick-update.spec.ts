import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Quick Update on the Loading Sheet — the daily container operations without
 * opening a shipment.
 *
 * A three-container order: from the Loading Sheet only, each container gets
 * its own ETA, containers 1 and 2 are marked loaded and 3 is left, the
 * documents move, container 1 arrives and is received. The order then reads
 * 2 / 3 Loaded, 1 / 3 Arrived, 1 / 3 Received — on the sheet, in the panel,
 * after a reload, on the shipment page and on the purchase order list. A
 * two-container order shows exactly two containers, and is deleted from its
 * row's menu.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const STAMP = Date.now().toString().slice(-5);
const THREE = {
  reference: `ICUL/FID/QU3-${STAMP}`,
  containers: [1, 2, 3].map((n) => `QUCU${STAMP}0${n}`),
  etas: ['2026-11-12', '2026-11-15', '2026-11-17'],
};
const TWO = { reference: `ICUL/FID/QU2-${STAMP}`, containers: [1, 2].map((n) => `QUDU${STAMP}0${n}`) };

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

/** A purchase order of n containers, entered the way the client enters one. */
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
  await first.getByLabel(/Split into containers/).fill(String(n));
  await first.getByRole('button', { name: new RegExp(`^Split into ${n}$`) }).click();
  await expect(lineCard(page, n)).toBeVisible();
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
  await expect(page.getByText(new RegExp(`${n} containers on this order`))).toBeVisible({ timeout: 45_000 });
}

async function sheetRow(page: Page, reference: string) {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const row = page.getByRole('row').filter({ hasText: reference }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  return row;
}

/** Quick Update, opened from the order's own row; every container shown. */
async function openQuick(page: Page, row: Locator, count: number) {
  await row.getByTestId('quick-update-open').click();
  const panel = page.getByTestId('quick-update');
  await expect(panel.locator('tr[data-container]')).toHaveCount(count, { timeout: 45_000 });
  return panel;
}

const containerRow = (panel: Locator, container: string) => panel.locator(`tr[data-container="${container}"]`);

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await signIn(page);
});
test.afterAll(async () => page?.context().close());

test('the orders are entered: three containers and two', async () => {
  await createOrder(page, THREE.reference, THREE.containers);
  await createOrder(page, TWO.reference, TWO.containers);
});

test('from the Loading Sheet only: own ETAs, 2 of 3 loaded, documents, one arrived and received', async () => {
  const row = await sheetRow(page, THREE.reference);
  await expect(row.locator('[data-summary="loading"]')).toHaveText('0 / 3 Loaded');
  const panel = await openQuick(page, row, 3);
  for (const container of THREE.containers) await expect(containerRow(panel, container)).toBeVisible();

  // Each container its own ETA — picked, and saved with no Save button.
  for (const [i, container] of THREE.containers.entries()) {
    const eta = containerRow(panel, container).getByLabel(/^ETA /);
    await eta.fill(THREE.etas[i]);
    await eta.blur();
    await expect(page.getByText(/ETA updated/).first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-summary="eta"]')).toContainText(i === 0 ? '12 Nov 2026' : i === 1 ? '12–15 Nov 2026' : '12–17 Nov 2026', { timeout: 30_000 });
  }

  // Containers 1 and 2 loaded together; 3 left as it is.
  await containerRow(panel, THREE.containers[0]).getByRole('checkbox').check();
  await containerRow(panel, THREE.containers[1]).getByRole('checkbox').check();
  await panel.getByRole('button', { name: /^Mark selected loaded$/ }).click();
  const form = panel.getByTestId('quick-bulk-form');
  await form.getByLabel('Shipping line', { exact: true }).selectOption({ index: 1 });
  await form.getByLabel('Booking', { exact: true }).fill(`BK-${STAMP}`);
  await form.getByRole('button', { name: /^Mark loaded$/ }).click();
  await expect(panel.locator('[data-summary="loading"]')).toHaveText('2 / 3 Loaded', { timeout: 45_000 });
  await expect(containerRow(panel, THREE.containers[2]).getByRole('button', { name: 'Not loaded' })).toHaveAttribute('aria-pressed', 'true');

  // Documents, straight from the row.
  await containerRow(panel, THREE.containers[0]).getByLabel(/^Documents /).selectOption({ label: 'Complete' });
  await expect(panel.locator('[data-summary="documents"]')).toContainText('1 Complete', { timeout: 30_000 });
  await containerRow(panel, THREE.containers[1]).getByLabel(/^Documents /).selectOption({ label: 'Awaiting Approval' });
  await expect(panel.locator('[data-summary="documents"]')).toContainText('1 Awaiting Approval', { timeout: 30_000 });
  await expect(panel.locator('[data-summary="documents"]')).toContainText('1 Pending');

  // Container 1 arrives.
  const first = containerRow(panel, THREE.containers[0]);
  await first.getByRole('button', { name: /Mark arrived/ }).click();
  await first.getByRole('button', { name: /^Save$/ }).click();
  await expect(panel.locator('[data-summary="arrival"]')).toHaveText('1 / 3 Arrived', { timeout: 45_000 });

  // And is received, the goods receipt opened with it already chosen.
  await containerRow(panel, THREE.containers[0]).getByRole('button', { name: /^Receive$/ }).click();
  await page.getByRole('button', { name: /^Receive (all|selected \(1\))$/ }).click();
  await expect(panel.locator('[data-summary="receipt"]')).toHaveText('1 / 3 Received', { timeout: 60_000 });
});

test('after a reload every status is where it was left — on the sheet, in the panel and on the shipment', async () => {
  const row = await sheetRow(page, THREE.reference);
  await expect(row.locator('[data-summary="loading"]')).toHaveText('2 / 3 Loaded');
  await expect(row.locator('[data-summary="arrival"]')).toHaveText('1 / 3 Arrived');
  await expect(row.locator('[data-summary="receipt"]')).toHaveText('1 / 3 Received');

  const panel = await openQuick(page, row, 3);
  for (const [i, container] of THREE.containers.entries()) {
    await expect(containerRow(panel, container).getByLabel(/^ETA /)).toHaveValue(THREE.etas[i]);
  }
  await expect(containerRow(panel, THREE.containers[0])).toHaveAttribute('data-stage', 'RECEIVED');
  await expect(containerRow(panel, THREE.containers[1])).toHaveAttribute('data-stage', 'LOADED');
  await expect(containerRow(panel, THREE.containers[2])).toHaveAttribute('data-stage', 'PENDING_LOADING');

  // Every change is in the container's history, with who made it.
  await containerRow(panel, THREE.containers[0]).getByRole('button', { name: /History/ }).click();
  const history = panel.getByTestId('container-history');
  await expect(history).toContainText('ETA', { timeout: 30_000 });
  await expect(history).toContainText('Status');
  await expect(history).toContainText('Documents');
  await expect(history).toContainText('Received');

  // The shipment page reads the same record: container 2 is Loaded there too.
  const open = containerRow(panel, THREE.containers[1]).getByRole('link', { name: /Open/ });
  const href = (await open.getAttribute('href')) ?? '';
  await page.goto(href, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/Loaded/, { timeout: 45_000 });
});

test('the purchase order list shows the same counts and opens the same panel', async () => {
  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const row = page.getByRole('row').filter({ hasText: THREE.reference }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(row).toContainText('2 / 3 Loaded');
  await expect(row).toContainText('1 / 3 Received');
  const panel = await openQuick(page, row, 3);
  await expect(panel.locator('[data-summary="arrival"]')).toHaveText('1 / 3 Arrived');
});

test('a two-container order shows two containers, and is deleted from its row', async () => {
  const row = await sheetRow(page, TWO.reference);
  const panel = await openQuick(page, row, 2);
  for (const container of TWO.containers) await expect(containerRow(panel, container)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-update')).toHaveCount(0);

  await row.getByRole('button', { name: /More actions/i }).click();
  await page.getByRole('menuitem', { name: /Delete shipment/ }).click();
  await page.getByLabel(/Why is this shipment being deleted/).fill('Entered twice by mistake');
  await page.getByRole('button', { name: /^Yes, delete$/ }).click();
  await expect(page.getByText(/Shipment deleted/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('row').filter({ hasText: TWO.reference })).toHaveCount(0, { timeout: 45_000 });

  // The order with a receipt cannot be deleted: the server refuses and says why.
  const received = await sheetRow(page, THREE.reference);
  await received.getByRole('button', { name: /More actions/i }).click();
  await page.getByRole('menuitem', { name: /Delete shipment/ }).click();
  await page.getByLabel(/Why is this shipment being deleted/).fill('Trying to delete a received order');
  await page.getByRole('button', { name: /^Yes, delete$/ }).click();
  await expect(page.getByText(/Goods have been received/).first()).toBeVisible({ timeout: 45_000 });
});
