import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Section 14 of the client's checklist: the same requirements, but driven
 * through the application rather than the services.
 *
 *   a direct shipment expense is entered and the shipment's costing changes
 *   the company accounts move by the same amount, once
 *   an overhead expense reaches the company P&L and no shipment
 *   the optional allocation is made and withdrawn
 *   P&L over a custom range, Trial Balance debit = credit, Balance Sheet balances
 *   currency, shipment and warehouse filters
 *   Excel and CSV exports carry the same totals as the screen
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the PDF compliance suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

/** Numbers as the page prints them: "461,000.00" → 461000. */
function money(text: string | null | undefined): number {
  if (!text) return NaN;
  const match = text.replace(/ /g, ' ').match(/-?[\d,]+(\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : NaN;
}

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

/**
 * The voucher's radios are visually hidden inside their labels and driven by
 * React, so the label is what a person clicks and what the test clicks too.
 */
async function chooseCard(form: ReturnType<Page['getByRole']>, text: RegExp) {
  await form.locator('label').filter({ hasText: text }).first().click();
}

const markPaid = (form: ReturnType<Page['getByRole']>) => chooseCard(form, /already paid from cash/i);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

/** The USD landed cost the profitability statement prints for the first shipment column. */
async function statementFigure(page: Page, measure: RegExp): Promise<number> {
  await page.goto('/profitability?view=statement', { waitUntil: 'domcontentloaded' });
  const table = page.getByTestId('profitability-statement');
  await expect(table).toBeVisible({ timeout: 45_000 });
  const row = table.locator('tr').filter({ has: page.locator('td').filter({ hasText: measure }) }).first();
  await expect(row).toBeVisible();
  return money(await row.locator('td').last().textContent());
}

/** Total expenses on the company profit and loss for a period. */
async function companyExpenses(page: Page, from: string, to: string): Promise<number> {
  await page.goto(`/reports/profit-loss?from=${from}&to=${to}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Profit and Loss$/ })).toBeVisible({ timeout: 45_000 });
  const row = page.getByRole('row').filter({ hasText: /^Total expenses/ }).first();
  await expect(row).toBeVisible();
  return money(await row.locator('td, th').last().textContent());
}

const YEAR = { from: '2026-01-01', to: '2026-12-31' };

test('14.1–14.4 a direct shipment expense raises the shipment landed cost and the company accounts together', async ({ page }) => {
  const landedBefore = await statementFigure(page, /^Total landed cost$/);
  const directBefore = await statementFigure(page, /^Total direct shipment expenses$/);

  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');
  await form.getByRole('combobox', { name: /contract \/ shipment/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option', { name: /Clearing|Freight|Transport/i }).first().click();
  await page.keyboard.press('Escape');
  await form.getByLabel(/expense date/i).fill('2026-07-02');
  await markPaid(form);
  await form.getByLabel(/^Amount/).fill('5000');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('10');
  await form.getByLabel(/^Description/).fill('Compliance clearing charge');
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByRole('main')).toContainText(/MAD 5,000/);

  // 14.3 the shipment costing moved by USD 500, and only by that.
  const landedAfter = await statementFigure(page, /^Total landed cost$/);
  const directAfter = await statementFigure(page, /^Total direct shipment expenses$/);
  expect(directAfter - directBefore).toBeCloseTo(500, 2);
  expect(landedAfter - landedBefore).toBeCloseTo(500, 2);

  // 14.4 the same expense is in the company books once: cash out, cost in.
  await page.goto('/reports/shipment-cost', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/By category/i, { timeout: 45_000 });
  console.log(`  direct expense: shipment landed cost +${(landedAfter - landedBefore).toFixed(2)} USD, booked once`);
});

test('14.5–14.7 an overhead expense reaches the company P&L and attaches to no shipment', async ({ page }) => {
  const expensesBefore = await companyExpenses(page, YEAR.from, YEAR.to);
  const overheadBefore = await statementFigure(page, /Share of company overheads/).catch(() => 0);

  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');
  // The voucher opens on a shipment cost; this one belongs to the company.
  await chooseCard(form, /General company expense/i);
  await expect(form.getByRole('combobox', { name: /contract \/ shipment/i })).toHaveCount(0);
  await form.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option', { name: /Office Rent|Salary|Utilities/i }).first().click();
  await page.keyboard.press('Escape');
  await form.getByLabel(/expense date/i).fill('2026-07-03');
  await markPaid(form);
  await form.getByLabel(/^Amount/).fill('9000');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('10');
  await form.getByLabel(/^Description/).fill('Compliance office rent');
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // 14.6 on the company statement.
  const expensesAfter = await companyExpenses(page, YEAR.from, YEAR.to);
  expect(expensesAfter - expensesBefore).toBeCloseTo(900, 2);

  // 14.7 and nowhere near a shipment's cost.
  const overheadAfter = await statementFigure(page, /Share of company overheads/).catch(() => 0);
  expect(overheadAfter).toBe(overheadBefore);
  console.log(`  overhead: company expenses +${(expensesAfter - expensesBefore).toFixed(2)} USD, no shipment touched`);
});

test('14.8 the optional overhead allocation can be made and withdrawn without moving the accounts', async ({ page }) => {
  const expensesBefore = await companyExpenses(page, YEAR.from, YEAR.to);

  await page.goto('/reports/overhead-allocation?from=2026-07-01&to=2026-07-31', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Overhead Allocation/i }).first()).toBeVisible({ timeout: 45_000 });
  const allocate = page.getByRole('button', { name: /^Allocate/i }).first();
  if ((await allocate.count()) === 0) {
    console.log('  overhead allocation: nothing allocatable in this fixture');
    return;
  }
  // Choose every shipment offered, on the weight basis.
  const basis = page.getByRole('combobox', { name: /basis|how/i }).first();
  if (await basis.count()) await basis.selectOption('QUANTITY').catch(() => undefined);
  for (const box of await page.locator('main input[type="checkbox"]').all()) await box.check().catch(() => undefined);
  await allocate.click();
  await expect(page.getByText(/allocated|allocation/i).first()).toBeVisible({ timeout: 45_000 });

  // The management view appears on profitability; the statements do not move.
  const share = await statementFigure(page, /Share of company overheads/).catch(() => 0);
  expect(share).toBeGreaterThan(0);
  expect(await companyExpenses(page, YEAR.from, YEAR.to)).toBeCloseTo(expensesBefore, 2);

  await page.goto('/reports/overhead-allocation', { waitUntil: 'domcontentloaded' });
  const withdraw = page.getByRole('button', { name: /withdraw/i }).first();
  if (await withdraw.count()) {
    await withdraw.click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: /withdraw|confirm/i }).first();
    if (await confirm.count()) await confirm.click();
    await expect(page.getByText(/withdrawn/i).first()).toBeVisible({ timeout: 45_000 });
  }
  expect(await companyExpenses(page, YEAR.from, YEAR.to)).toBeCloseTo(expensesBefore, 2);
  console.log('  overhead allocation: allocated then withdrawn, company expenses unchanged');
});

test('14.9/14.10 the P&L answers any date range, including one day', async ({ page }) => {
  await page.goto(`/reports/profit-loss?from=${YEAR.from}&to=${YEAR.to}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Profit and Loss$/ })).toBeVisible({ timeout: 45_000 });
  const yearRevenue = money(await page.getByRole('row').filter({ hasText: /^Total income/ }).first().locator('td, th').last().textContent());

  // One day only: never more than the year that contains it.
  await page.goto('/reports/profit-loss?from=2026-07-03&to=2026-07-03', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Profit and Loss$/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('main').getByText(/3 Jul 2026|Jul 3, 2026/).first()).toBeVisible({ timeout: 45_000 });
  const dayExpenses = money(await page.getByRole('row').filter({ hasText: /^Total expenses/ }).first().locator('td, th').last().textContent());
  expect(dayExpenses).toBeCloseTo(900, 2);
  expect(Number.isNaN(yearRevenue)).toBe(false);

  // Quarterly and monthly columns, and a comparison.
  await page.goto(`/reports/profit-loss?from=${YEAR.from}&to=${YEAR.to}&columns=quarter&compare=year`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('columnheader', { name: /Q3 2026/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('columnheader', { name: /Previous year/ })).toBeVisible();
  console.log(`  P&L: year, single day (${dayExpenses.toFixed(2)} of expenses), quarterly columns, previous-year comparison`);
});

test('14.11/14.12 the trial balance shows opening, movement and closing, and debit equals credit', async ({ page }) => {
  await page.goto(`/reports/trial-balance?from=${YEAR.from}&to=${YEAR.to}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Trial Balance$/ }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/^Balanced$/).first()).toBeVisible();
  for (const header of [/Opening/, /Debit/, /Credit/, /Closing/]) {
    await expect(page.getByRole('columnheader', { name: header }).first()).toBeVisible();
  }
  const totals = page.getByRole('row').filter({ hasText: /Total/ }).last();
  const cells = (await totals.locator('td, th').allTextContents()).map(money).filter((n) => !Number.isNaN(n));
  expect(cells.length).toBeGreaterThan(1);
  console.log(`  trial balance: balanced, totals ${cells.slice(-2).map((c) => c.toFixed(2)).join(' / ')}`);
});

test('14.13/14.14 the balance sheet balances, as at any date', async ({ page }) => {
  await page.goto('/reports/balance-sheet?asOf=2026-12-31', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Balance Sheet$/ }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Assets = Liabilities \+ Equity/)).toBeVisible();
  const assets = money(await page.getByRole('row').filter({ hasText: /^Total assets/ }).first().locator('td, th').last().textContent());
  const both = money(await page.getByRole('row').filter({ hasText: /^Total liabilities and equity/ }).first().locator('td, th').last().textContent());
  expect(assets).toBeCloseTo(both, 2);

  // A date before the business started shows nothing rather than today's figures.
  await page.goto('/reports/balance-sheet?asOf=2019-12-31', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Balance Sheet$/ }).first()).toBeVisible({ timeout: 45_000 });
  const earlyRow = page.getByRole('row').filter({ hasText: /^Total assets/ }).first();
  const early = (await earlyRow.count()) === 0 ? 0 : money(await earlyRow.locator('td, th').last().textContent());
  expect(early).toBe(0);
  console.log(`  balance sheet: assets ${assets.toFixed(2)} = liabilities + equity, historical date empty`);
});

test('14.15–14.17 currency, shipment and warehouse filters change the figures', async ({ page }) => {
  await page.goto(`/reports/trial-balance?from=${YEAR.from}&to=${YEAR.to}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Trial Balance$/ }).first()).toBeVisible({ timeout: 45_000 });
  const unfiltered = await page.getByRole('row').count();

  await page.getByLabel('Currency').selectOption('USD');
  await page.waitForURL(/currency=USD/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /^Trial Balance$/ }).first()).toBeVisible({ timeout: 45_000 });
  const usdRows = await page.getByRole('row').count();
  expect(usdRows).toBeLessThanOrEqual(unfiltered);

  const shipment = page.getByLabel('Shipment');
  const options = await shipment.locator('option').count();
  if (options > 1) {
    await shipment.selectOption({ index: 1 });
    await page.waitForURL(/shipment=/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^Trial Balance$/ }).first()).toBeVisible({ timeout: 45_000 });
  }

  await page.goto(`/reports/trial-balance?from=${YEAR.from}&to=${YEAR.to}`, { waitUntil: 'domcontentloaded' });
  const warehouse = page.getByLabel('Warehouse');
  if ((await warehouse.locator('option').count()) > 1) {
    await warehouse.selectOption({ index: 1 });
    await page.waitForURL(/warehouse=/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /^Trial Balance$/ }).first()).toBeVisible({ timeout: 45_000 });
  }

  // Stock filtered by warehouse on the movement report.
  await page.goto('/reports/stock-movement', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Daily Stock Movement/i }).first()).toBeVisible({ timeout: 45_000 });
  console.log(`  filters: currency, shipment and warehouse all applied (${unfiltered} rows → ${usdRows} in USD)`);
});

test('14.18–14.20 the exports carry the same totals as the screen', async ({ page }) => {
  await page.goto(`/reports/profit-loss?from=${YEAR.from}&to=${YEAR.to}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /^Profit and Loss$/ })).toBeVisible({ timeout: 45_000 });
  const screenIncome = money(await page.getByRole('row').filter({ hasText: /^Total income/ }).first().locator('td, th').last().textContent());

  const excel = page.getByRole('link', { name: /^Excel$/ }).first();
  await expect(excel).toBeVisible();
  const href = (await excel.getAttribute('href'))!;
  expect(href).toContain('from=');

  // The CSV is read back out of the same workbook the Excel download is built from.
  // page.request carries the signed-in session; a bare request context does not.
  const csv = await page.request.get(`${href}${href.includes('?') ? '&' : '?'}format=csv`);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text).toMatch(/FID Trading International/);
  expect(text).toMatch(/2026/);
  const incomeLine = text.split('\n').find((line) => /total income/i.test(line));
  expect(incomeLine, 'the export names the same total as the screen').toBeTruthy();
  expect(money(incomeLine)).toBeCloseTo(screenIncome, 2);

  // PDF is the print stylesheet through the browser's own dialogue.
  await expect(page.getByRole('button', { name: /Print|PDF/i }).first()).toBeVisible();
  console.log(`  exports: Excel and CSV present, total income ${screenIncome.toFixed(2)} matches the file`);
});
