import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * A shipment expense on a three-container order, through the form.
 *
 * E2E-PO-MA-3C (the fixture) carries three containers, one coffee each, on
 * three shipment records. The form offers the order once and all three
 * containers plus Whole shipment. MAD 6,000 named to the second container
 * lands on it alone; MAD 30,000 for the whole shipment is one expense, a
 * third on each.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ORDER = 'E2E-PO-MA-3C';
const RUN = Date.now().toString(36).slice(-5);

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
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

async function choose(page: Page, combobox: Locator, text?: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await combobox.click();
    if (text) await page.keyboard.type(text, { delay: 20 });
    const options = page.getByRole('listbox').getByRole('option');
    const option = text ? options.filter({ hasText: text }).first() : options.first();
    const shown = await option.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (shown && (await option.click({ timeout: 5_000 }).then(() => true).catch(() => false))) return;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  throw new Error('the picker never stayed open long enough to choose');
}

async function openForm(page: Page) {
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByRole('main');
  await choose(page, form.getByRole('combobox', { name: /contract \/ shipment/i }), ORDER);
  await choose(page, form.getByRole('combobox', { name: /^category/i }));
  return form;
}

async function post(page: Page, form: Locator, amount: string, memo: string) {
  await form.getByLabel(/^Amount/).fill(amount);
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('9.85');
  await form.getByLabel(/^Memo/).fill(memo);
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('the order is offered once, with Whole shipment and its three containers', async ({ page }) => {
  const form = await openForm(page);
  await form.getByRole('combobox', { name: /^Container/ }).click();
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(options.nth(0)).toHaveText(/Whole shipment/);
  for (const n of ['E2EC3000001', 'E2EC3000002', 'E2EC3000003']) {
    await expect(options.filter({ hasText: n })).toHaveCount(1);
  }
  await expect(options.filter({ hasText: 'E2EC3000002' })).toContainText(/Screen 15 — 20,000 KG/);
});

test('MAD 6,000 on the second container, then MAD 30,000 for the whole shipment', async ({ page }) => {
  let form = await openForm(page);
  await choose(page, form.getByRole('combobox', { name: /^Container/ }), 'E2EC3000002');
  await post(page, form, '6000', `Container two only ${RUN}`);

  form = await openForm(page);
  await post(page, form, '30000', `Whole shipment ${RUN}`);

  // The order's page: each cost listed once, against its container or the whole shipment.
  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  const link = page.locator('a[href^="/shipments/"]').filter({ hasText: ORDER }).first();
  await expect(link).toBeVisible({ timeout: 45_000 });
  await link.click();
  await page.waitForURL(/\/shipments\/[\w-]+$/, { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  const specific = page.getByTestId('shipment-expense-row').filter({ hasText: `Container two only ${RUN}` });
  const whole = page.getByTestId('shipment-expense-row').filter({ hasText: `Whole shipment ${RUN}` });
  await expect(specific).toHaveCount(1, { timeout: 30_000 });
  await expect(whole).toHaveCount(1);
  await expect(specific).toContainText('E2EC3000002');
  await expect(whole).toContainText('Whole shipment');

  // The costing: 16,000 on the second container, 10,000 on each of the others.
  const shared = async (container: string) => {
    const row = main.locator('table tbody tr').filter({ hasText: container }).filter({ hasText: /Screen/ }).first();
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    return Number((text.match(/MAD ([\d,]+\.\d{2})/)?.[1] ?? '0').replace(/,/g, ''));
  };
  expect(await shared('E2EC3000001')).toBeCloseTo(10_000, -1);
  expect(await shared('E2EC3000002')).toBeCloseTo(16_000, -1);
  expect(await shared('E2EC3000003')).toBeCloseTo(10_000, -1);
});
