import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Stock on Hand, by item, on screen.
 *
 * Opens Stock on Hand, picks a coffee that has sold, and checks every figure
 * the client asks about — received, sold, available, where it is, revenue,
 * collected, outstanding, average cost and selling price, cost of goods sold
 * and profit — against each other and against the item's own page: its
 * warehouses, its payment methods, its shipments, containers and batches, and
 * the invoices that sold it. Nothing is hard-coded: whatever the books hold,
 * the numbers must reconcile.
 *
 * Named to run after the suites that sell and transfer stock.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

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

/** The first figure in a cell: "MAD 1,234.50" (the USD equivalent under it ignored), "Loss MAD 8.00" negative, "1,200.5 KG". */
function amount(text: string): number {
  const first = text.trim().split('\n')[0];
  const match = /-?[\d,]+(?:\.\d+)?/.exec(first);
  const value = match ? Number(match[0].replace(/,/g, '')) : NaN;
  return /^Loss\b/.test(first) ? -value : value;
}

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signIn(page);
});
test.afterAll(async () => page?.context().close());

type Row = {
  name: string;
  href: string;
  received: number;
  sold: number;
  available: number;
  avgCost: number;
  avgSell: number;
  revenue: number;
  collected: number;
  outstanding: number;
  cogs: number;
  profit: number;
  stockValue: number;
};
let row: Row;

async function readRow(table: Locator, tr: Locator): Promise<Row> {
  const headers = (await table.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const cells = await tr.locator('> td').allInnerTexts();
  const at = (name: string) => {
    const i = headers.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
    return i >= 0 ? amount(cells[i] ?? '') : NaN;
  };
  const link = tr.getByTestId('item-link');
  return {
    name: (await link.innerText()).trim(),
    href: (await link.getAttribute('href')) ?? '',
    received: at('Received KG'),
    sold: at('Sold KG'),
    available: at('Available KG'),
    avgCost: at('Avg Cost/KG'),
    avgSell: at('Avg Sell/KG'),
    revenue: at('Sales Revenue'),
    collected: at('Collected'),
    outstanding: at('Outstanding'),
    cogs: at('COGS'),
    profit: at('Gross Profit / Loss'),
    stockValue: at('Stock Value'),
  };
}

const figure = async (id: string) => amount(await page.getByTestId(id).locator('[data-figure-value]').innerText());

test('Stock on Hand lists every coffee with its stock, sales, money and profit, and the figures agree', async () => {
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  const table = page.getByTestId('item-stock-table').locator('table').first();
  await expect(table).toBeVisible({ timeout: 45_000 });
  for (const header of ['Item', 'Received KG', 'Sold KG', 'Available KG', 'Warehouses', 'Avg Cost/KG', 'Avg Sell/KG', 'Sales Revenue', 'Collected', 'Outstanding', 'COGS', 'Gross Profit / Loss', 'Margin', 'Stock Value', 'Actions']) {
    await expect(table.locator('thead th', { hasText: header }).first()).toBeVisible();
  }

  // A coffee that has sold — the Screen 18 when the books have one.
  const rows = table.locator('tbody > tr').filter({ has: page.getByTestId('item-link') });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  let chosen: Row | null = null;
  for (let i = 0; i < count; i += 1) {
    const candidate = await readRow(table, rows.nth(i));
    if (candidate.sold > 0 && (!chosen || /Screen 18/i.test(candidate.name))) chosen = candidate;
  }
  test.skip(!chosen, 'Nothing has sold in the fixture yet.');
  row = chosen!;

  // Profit is revenue less cost; the averages are the totals over the KG.
  expect(row.profit).toBeCloseTo(row.revenue - row.cogs, 1);
  expect(row.avgSell * row.sold).toBeCloseTo(row.revenue, -1);
  expect(row.collected + row.outstanding).toBeGreaterThan(0);

  // The warehouses add up to the company's available stock.
  const tr = rows.filter({ hasText: row.name }).first();
  await tr.getByRole('button', { name: /Show detail/i }).click();
  // The table's own copy (the phone layout renders the same detail in a card).
  const split = table.getByTestId('item-warehouse-split').first();
  await expect(split).toBeVisible();
  const availableCells = await split.locator('tbody tr').evaluateAll((trs) =>
    trs.map((r) => ({ name: r.querySelector('td')?.textContent ?? '', available: r.querySelector('td:last-child')?.textContent ?? '' })),
  );
  const sites = availableCells.filter((c) => c.name !== 'Total');
  const total = availableCells.find((c) => c.name === 'Total')!;
  expect(sites.reduce((s, c) => s + amount(c.available), 0)).toBeCloseTo(row.available, 3);
  expect(amount(total.available)).toBeCloseTo(row.available, 3);

  // The whole company reconciles with Current Stock, the invoices, Shipment Profitability and Outstanding Invoices.
  const recon = page.getByTestId('stock-reconciliation');
  if (await recon.count()) {
    await recon.locator('summary').click();
    await expect(recon.locator('[data-ok="false"]')).toHaveCount(0);
    expect(await recon.locator('[data-ok="true"]').count()).toBeGreaterThanOrEqual(8);
  }
  console.log(`  ${row.name}: received ${row.received}, sold ${row.sold}, available ${row.available}, revenue ${row.revenue}, profit ${row.profit}`);
});

test('the item page says the same, and its warehouses, payments, shipments and invoices add back up to it', async () => {
  test.skip(!row, 'No item chosen.');
  await page.goto(row.href, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: row.name }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { name: 'Item Stock & Profitability' })).toBeVisible();

  // The summary is the row.
  expect(await figure('item-received')).toBeCloseTo(row.received, 3);
  expect(await figure('item-sold')).toBeCloseTo(row.sold, 3);
  expect(await figure('item-available')).toBeCloseTo(row.available, 3);
  expect(await figure('item-avg-cost')).toBeCloseTo(row.avgCost, 2);
  expect(await figure('item-avg-sell')).toBeCloseTo(row.avgSell, 2);
  expect(await figure('item-revenue')).toBeCloseTo(row.revenue, 2);
  expect(await figure('item-collected')).toBeCloseTo(row.collected, 2);
  expect(await figure('item-outstanding')).toBeCloseTo(row.outstanding, 2);
  expect(await figure('item-cogs')).toBeCloseTo(row.cogs, 2);
  expect(await figure('item-profit')).toBeCloseTo(row.profit, 2);
  await expect(page.getByTestId('item-profit')).toContainText(row.profit < 0 ? 'Gross loss' : 'Gross profit');

  // Stock by warehouse: the TOTAL is the item's available stock.
  const warehouses = page.getByTestId('item-warehouses');
  const siteAvailable = await warehouses.locator('tbody [data-cell="available"]').allInnerTexts();
  expect(siteAvailable.reduce((s, t) => s + amount(t), 0)).toBeCloseTo(row.available, 3);
  expect(amount(await warehouses.locator('tfoot [data-cell="available"]').innerText())).toBeCloseTo(row.available, 3);

  // How it was paid: every method plus what is outstanding is what was invoiced.
  const payments = page.getByTestId('payment-breakdown');
  const methods = await payments.locator('tbody tr').evaluateAll((trs) =>
    trs.map((r) => ({ method: r.getAttribute('data-method') ?? '', amount: (r.querySelector('td:last-child') as HTMLElement | null)?.innerText ?? '' })),
  );
  const collected = methods.filter((m) => !['OUTSTANDING', 'CREDIT'].includes(m.method)).reduce((s, m) => s + amount(m.amount), 0);
  expect(collected).toBeCloseTo(row.collected, 2);
  const invoiced = amount(await payments.locator('tfoot td').last().innerText());
  expect(methods.reduce((s, m) => s + amount(m.amount), 0)).toBeCloseTo(invoiced, 2);
  await expect(payments.locator('[data-method="AGENT"]')).toContainText('Agent collection');

  // By shipment: the shipments add up to the item.
  const shipments = page.getByTestId('item-shipments');
  const shipmentRows = shipments.locator('tbody tr');
  expect(await shipmentRows.count()).toBeGreaterThan(0);
  const shipmentHeaders = (await shipments.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const col = (name: string) => shipmentHeaders.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
  const sums = { received: 0, sold: 0, sales: 0, cogs: 0 };
  for (const r of await shipmentRows.all()) {
    const cells = await r.locator('td').allInnerTexts();
    sums.received += amount(cells[col('Received KG')]);
    sums.sold += amount(cells[col('Sold KG')]);
    sums.sales += amount(cells[col('Sales')]);
    sums.cogs += amount(cells[col('COGS')]);
  }
  expect(sums.received).toBeCloseTo(row.received, 3);
  expect(sums.sold).toBeCloseTo(row.sold, 3);
  expect(sums.sales).toBeCloseTo(row.revenue, 1);
  expect(sums.cogs).toBeCloseTo(row.cogs, 1);

  // Sales against this item: the lines add up to the KG sold and the money.
  const sales = page.getByTestId('item-sales');
  const salesHeaders = (await sales.locator('thead th').allInnerTexts()).map((h) => h.trim());
  const footer = await sales.locator('tfoot td').allInnerTexts();
  const s = (name: string) => amount(footer[salesHeaders.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()))]);
  expect(s('Qty sold')).toBeCloseTo(row.sold, 3);
  expect(s('Paid')).toBeCloseTo(row.collected, 1);
  expect(s('Outstanding')).toBeCloseTo(row.outstanding, 1);

  // Every per-item identity holds.
  const recon = page.getByTestId('item-reconciliation');
  await expect(recon.locator('[data-ok="false"]')).toHaveCount(0);
  expect(await recon.locator('[data-ok="true"]').count()).toBeGreaterThanOrEqual(6);
});

test('drills from shipment to container to batch to warehouse to the invoices, and on to the invoice', async () => {
  test.skip(!row, 'No item chosen.');
  await page.goto(row.href, { waitUntil: 'domcontentloaded' });
  const drill = page.getByTestId('item-drilldown');
  await expect(drill).toBeVisible({ timeout: 45_000 });
  const sold = drill.locator('details[data-level="shipment"]').filter({ has: page.locator('[data-fact="Sold"]') });
  // The first shipment that sold something.
  let opened = false;
  for (const shipment of await drill.locator('details[data-level="shipment"]').all()) {
    const soldText = await shipment.locator('> summary [data-fact="Sold"]').innerText();
    if (amount(soldText.replace(/^Sold\s*/, '')) <= 0) continue;
    await shipment.locator('> summary').click();
    const container = shipment.locator('details[data-level="container"]').first();
    await container.locator('> summary').click();
    const batch = container.locator('details[data-level="batch"]').first();
    await batch.locator('> summary').click();
    await expect(batch.locator('[data-level="warehouse"]').first()).toBeVisible();
    const invoice = batch.getByTestId('drill-sales').locator('tbody tr').first();
    if (!(await invoice.count())) {
      await shipment.locator('> summary').click();
      continue;
    }
    const number = (await invoice.getAttribute('data-invoice')) ?? '';
    expect(number).not.toBe('');
    // The same invoice is in the item's sales list.
    await expect(page.getByTestId('item-sales').locator(`tr[data-invoice="${number}"]`).first()).toBeAttached();
    // The invoice as the rest of the ERP names it ("INV 1"), opening the invoice itself.
    const link = invoice.getByRole('link').first();
    const shown = (await link.innerText()).trim();
    await link.click();
    await page.waitForURL(/\/sales\/[\w-]+$/, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main')).toContainText(shown, { timeout: 45_000 });
    opened = true;
    break;
  }
  expect(opened || (await sold.count()) === 0).toBe(true);
});

test('Customize Report remembers the columns, Sort by orders the items, and a warehouse filter narrows every figure', async () => {
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  const wrapper = page.getByTestId('item-stock-table');
  const table = wrapper.locator('table').first();
  await expect(table).toBeVisible({ timeout: 45_000 });

  // Hide Margin, reload: still hidden. Then put it back.
  await wrapper.getByRole('button', { name: 'Customize Report' }).click();
  await page.getByRole('checkbox', { name: 'Margin' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(table.locator('thead th', { hasText: /^Margin$/ })).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('item-stock-table').locator('table').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('item-stock-table').locator('table').first().locator('thead th', { hasText: /^Margin$/ })).toHaveCount(0);
  await page.getByTestId('item-stock-table').getByRole('button', { name: 'Customize Report' }).click();
  await page.getByRole('checkbox', { name: 'Margin' }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('item-stock-table').locator('table').first().locator('thead th', { hasText: /^Margin$/ })).toHaveCount(1);

  // Highest sales first.
  const sortBy = page.getByTestId('item-stock-table').getByLabel('Sort by');
  await sortBy.selectOption({ label: 'Highest sales' });
  const t = page.getByTestId('item-stock-table').locator('table').first();
  const rows = t.locator('tbody > tr').filter({ has: page.getByTestId('item-link') });
  if ((await rows.count()) >= 2) {
    const a = await readRow(t, rows.nth(0));
    const b = await readRow(t, rows.nth(1));
    expect(a.revenue).toBeGreaterThanOrEqual(b.revenue);
  }
  await sortBy.selectOption({ label: 'Sort by: default' });

  // One warehouse: every figure on the page is that warehouse's.
  const filters = page.getByTestId('stock-filters');
  const warehouse = filters.locator('#stock-warehouse');
  const choices = (await warehouse.locator('option').allInnerTexts()).filter((o) => o !== 'All');
  test.skip(choices.length === 0, 'No warehouse to filter by.');
  await warehouse.selectOption({ label: choices[0] });
  await filters.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/warehouse=/, { waitUntil: 'domcontentloaded' });
  const narrowed = page.getByTestId('item-stock-table').locator('table').first();
  await expect(narrowed.or(page.getByText('No stock or sales yet'))).toBeVisible({ timeout: 45_000 });
  const available = await figure('total-available');
  const narrowedRows = narrowed.locator('tbody > tr').filter({ has: page.getByTestId('item-link') });
  let sum = 0;
  for (const r of await narrowedRows.all()) sum += (await readRow(narrowed, r)).available;
  expect(sum).toBeCloseTo(available, 3);
});
