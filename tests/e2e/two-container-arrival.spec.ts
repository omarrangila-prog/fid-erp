import { test, expect, type Page } from '@playwright/test';

/**
 * §34 — one order, two containers, watched through arrival and receipt.
 *
 * The client marked containers arrived and the order still read "0 of 2",
 * and a shipment that had been received in full still read as pending. The
 * cause was a status nobody kept in step with the goods; these are the
 * counts that showed it, driven in a browser.
 *
 * The second half walks the path the client was actually on: receiving the
 * coffee without first pressing "Mark all arrived". That is what the five
 * integration tests cover at the engine; this is the same thing read off
 * the screen.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run.');
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now().toString().slice(-5);
const REFERENCE = `HRCC/E2E-${STAMP}`;
const CONTAINERS = [
  { kg: '19200', lot: `LOT-A-${STAMP}`, batch: `BAT-A-${STAMP}`, container: `CAAU${STAMP}01` },
  { kg: '19200', lot: `LOT-B-${STAMP}`, batch: `BAT-B-${STAMP}`, container: `CAAU${STAMP}02` },
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
    return;
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

/** The same locator the order spec uses: the card headed "Container n". */
const lineCard = (page: Page, n: number) =>
  page.locator('div.rounded-xl.p-4').filter({ has: page.getByText(`Container ${n}`, { exact: true }) });

test('an order of two containers starts with nothing arrived', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);

  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.locator('#contractReference').fill(REFERENCE);
  const supplier = page.locator('#vendorId');
  await expect(supplier).toBeVisible({ timeout: 30_000 });
  await supplier.click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.locator('#containers').fill('2');

  const first = lineCard(page, 1);
  await first.getByRole('combobox').first().click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await first.getByLabel(/^Quantity/).fill('38400');
  await first.getByRole('textbox', { name: /Rate per unit|Price per unit/ }).fill('4.00');
  await first.getByLabel(/Split into containers/).fill('2');
  await first.getByRole('button', { name: /^Split into 2$/ }).click();
  await expect(lineCard(page, 2)).toBeVisible();

  for (const [index, line] of CONTAINERS.entries()) {
    const card = lineCard(page, index + 1);
    await card.getByLabel(/^Quantity/).fill(line.kg);
    await card.getByRole('textbox', { name: /Rate per unit|Price per unit/ }).fill('4.00');
    await card.getByText(/Lot, batch, container and packing/).click();
    await card.getByLabel(/lot number/i).fill(line.lot);
    await card.getByLabel(/batch number/i).fill(line.batch);
    await card.getByLabel(/container number/i).fill(line.container);
  }

  await page.getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Save purchase order$/ }).click();
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  orderUrl = page.url();

  // Nothing has arrived, and the page says so in as many words. This is the
  // one state in which "0 of 2" is the right answer.
  await expect(page.getByText(/2 containers on this order/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/0 of 2 containers arrived/).first()).toBeVisible();
  console.log(`  ${REFERENCE}: 0 of 2 arrived, which is correct before anything lands`);
});

test('receiving the coffee is what makes it arrived, without pressing anything else', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  /*
   * Straight to receiving, with no "Mark all arrived" first. This is the
   * path the client took, and the one that used to leave the order reading
   * "0 of 2" while the coffee was on the shelf.
   */
  await page.getByRole('button', { name: /Receive goods/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  // Take the first container only, so the partial state can be read.
  const rows = dialog.getByRole('row').filter({ hasText: CONTAINERS[0].container });
  if ((await rows.count()) > 0) {
    const others = dialog.getByRole('row').filter({ hasText: CONTAINERS[1].container });
    const tick = others.getByRole('checkbox').first();
    if ((await tick.count()) && (await tick.isChecked())) await tick.uncheck();
  }
  await dialog.getByRole('button', { name: /^Receive/i }).first().click();
  await expect(dialog).toHaveCount(0, { timeout: 90_000 });

  await page.waitForLoadState('networkidle').catch(() => undefined);
  const partial = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
  expect(partial, 'one container in means one arrived, not none').toMatch(/1 of 2 containers arrived/);
  console.log('  after receiving one: 1 of 2 arrived');
});

test('the second container takes it to fully arrived and fully received', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByRole('button', { name: /Receive goods/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /^Receive/i }).first().click();
  await expect(dialog).toHaveCount(0, { timeout: 90_000 });

  await page.waitForLoadState('networkidle').catch(() => undefined);
  const full = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
  expect(full).toMatch(/2 of 2 containers arrived/);
  expect(full).toMatch(/Fully arrived/i);
  expect(full).toMatch(/2 of 2/);
  // And nothing anywhere still calls it pending.
  expect(full).not.toMatch(/Pending arrival/i);
  console.log('  after receiving both: 2 of 2 arrived, fully arrived, not pending');
});

test('the purchase list and the loading sheet say the same thing', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);

  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const listRow = page.getByRole('row').filter({ hasText: REFERENCE }).first();
  await expect(listRow).toBeVisible({ timeout: 45_000 });
  await expect(listRow).toContainText(/2 of 2 containers arrived/);

  await page.goto('/loading', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const sheetRow = page.getByRole('row').filter({ hasText: REFERENCE }).first();
  if ((await sheetRow.count()) > 0) {
    const sheetText = (await sheetRow.innerText()).replace(/\s+/g, ' ');
    expect(sheetText, 'the loading sheet must not call a received order pending').not.toMatch(/Pending arrival/i);
    console.log(`  loading sheet: ${sheetText.slice(0, 90)}`);
  }
});
