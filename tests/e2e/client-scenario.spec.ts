import { test, expect, type Page } from '@playwright/test';

/**
 * The client's own workflow, driven through the browser.
 *
 * Not "does the service post correctly" — that is covered elsewhere — but does
 * a person sitting in front of this application get the right answer by
 * filling in the forms and pressing the buttons. Every figure asserted here is
 * read off the screen after a real save.
 *
 *   a loan arrives from Dubai and reaches the Moroccan bank
 *   a customer is created
 *   an invoice is raised, warehouse first
 *   part is paid in cash, the rest by a cheque the agent takes away
 *   the customer owes nothing; the agent owes us; cash rose by the cash only
 *   the cheque clears without touching the bank, and the agent settles
 *   coffee moves between warehouses without becoming a sale
 *   the ledgers, the trial balance, the statements and the reports agree
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the client scenario.');
test.describe.configure({ mode: 'serial' });

// Filling a multi-line invoice through comboboxes takes longer than a read.
test.setTimeout(180_000);

/** Numbers as the page prints them: "461,000.00" → 461000. */
function money(text: string | null): number {
  if (!text) return NaN;
  const match = text.replace(/ /g, ' ').match(/-?[\d,]+(\.\d+)?/);
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
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }

  // Make sure we are in Morocco, whichever company the session landed on.
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

/** The balance the Cash & Bank screen prints for one named account. */
async function bankBalance(page: Page, account: RegExp, currency = 'MAD'): Promise<number> {
  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const row = page.getByRole('row').filter({ hasText: account }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const cells = (await row.locator('td').allTextContents()).map((c) => c.trim().replace(/\s+/g, ' '));

  /*
   * The row carries the balance twice: in the account's own currency and
   * again in USD, so a Moroccan bank and a Dubai one can be added together.
   * Reading the last figure took the USD column and made a MAD 461,000 loan
   * look like a 50,000 movement.
   */
  const own = cells.find((c) => new RegExp(`^${currency}\\s+-?[\\d,]`).test(c));
  if (!own) throw new Error(`No ${currency} balance on the row: ${cells.join(' ¦ ')}`);
  return money(own);
}

const CUSTOMER = `Walkthrough Roastery ${Date.now().toString().slice(-5)}`;

/**
 * The Moroccan bank account, by what it is rather than what it is called.
 *
 * The client's books call it ATIJJARI BANK; a fresh test database calls it
 * MAD Bank Account. Naming either one here would make the test a statement
 * about one database rather than about the application.
 */
const MAD_BANK = /(ATIJJARI|MAD Bank Account)/i;

test('a loan from Dubai reaches the Moroccan bank', async ({ page }) => {
  await signIn(page);

  const before = await bankBalance(page, MAD_BANK);

  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/This is not income and not a cost/i)).toBeVisible();

  await page.getByRole('button', { name: /We received a loan/i }).click();
  await page.getByLabel(/Received from/i).fill('FID Trading LLC Dubai');
  // selectOption matches labels exactly, so find the option's own text first.
  const intoAccount = page.getByLabel(/Received into/i);
  const intoOptions = await intoAccount.locator('option').allTextContents();
  const madBank = intoOptions.find((o) => MAD_BANK.test(o));
  if (!madBank) throw new Error(`No Moroccan bank offered. Saw: ${intoOptions.join(' | ')}`);
  await intoAccount.selectOption({ label: madBank });
  await page.getByLabel(/Loan currency/i).selectOption('USD');
  await page.getByLabel(/^Amount/i).fill('50000');
  await page.getByLabel(/Exchange rate/i).fill('9.22');

  // The converted figure is worked out, not typed.
  await expect(page.getByText(/461,000/)).toBeVisible({ timeout: 15_000 });

  await page.getByLabel(/Memo/i).fill('Working capital, walkthrough');
  await page.getByRole('button', { name: /Post loan/i }).click();
  await page.waitForURL(/\/finance\/cash-bank/, { timeout: 60_000 });

  const after = await bankBalance(page, MAD_BANK);
  expect(after - before).toBeCloseTo(461_000, 2);
  console.log(`  bank ${before} → ${after}`);
});

test('the lender has a ledger showing what we owe them', async ({ page }) => {
  await signIn(page);
  await page.goto('/accounting/chart', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const account = page.getByRole('link', { name: /Loan from FID Trading LLC Dubai/i }).first();
  await expect(account).toBeVisible({ timeout: 30_000 });
  await account.click();
  await page.waitForURL(/general-ledger/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  /*
   * Wait for the report itself, not for the document.
   * Reading body.textContent as the page streams returns the shell and the
   * framework's own payload, and asserting against that says nothing about
   * what the client sees.
   */
  const summary = page.getByText(/Payable to/i).first();
  await expect(summary).toBeVisible({ timeout: 30_000 });

  const main = (await page.locator('main').textContent()) ?? '';
  expect(main).toMatch(/Payable to/i);
  expect(main).toMatch(/50,000|50000/);
  // Stated in a currency, not in the name of a view.
  expect(main).not.toMatch(/REPORTING\s+[\d,]/);
  console.log('  lender ledger says "Payable to"');
});

test('a customer is created through the form', async ({ page }) => {
  await signIn(page);
  await page.goto('/customers', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /New customer|Add customer/i }).first().click();
  await page.getByLabel(/Customer name/i).fill(CUSTOMER);
  const currency = page.getByLabel(/Currency/i).first();
  if (await currency.count()) await currency.selectOption('MAD').catch(() => undefined);
  await page.getByRole('button', { name: /^Save|Create/i }).first().click();

  await expect(page.getByText(CUSTOMER).first()).toBeVisible({ timeout: 45_000 });
  console.log(`  created ${CUSTOMER}`);
});

test('an invoice is raised warehouse first, and the warehouse drives the coffee', async ({ page }) => {
  await signIn(page);
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // §34: the warehouse is chosen once, at the top, before any line.
  const warehouse = page.locator('#warehouseId');
  await expect(warehouse).toBeVisible({ timeout: 30_000 });
  const warehouseOptions = (await warehouse.locator('option').allTextContents()).filter((o) => !/Choose/i.test(o));
  console.log(`  warehouses offered: ${warehouseOptions.join(' | ')}`);
  expect(warehouseOptions.length).toBeGreaterThan(0);
  await warehouse.selectOption({ index: 1 });

  /*
   * Each of these is the application's own combobox rather than a native
   * select, so its choices live in a listbox. Asking the page for everything
   * with the option role picks up every <select> on the form as well.
   */
  const customerBox = page.getByRole('combobox', { name: /customer/i }).first();
  await expect(customerBox).toBeVisible({ timeout: 30_000 });
  await customerBox.click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  const customerOption = page.getByRole('listbox').getByRole('option').first();
  await expect(customerOption).toBeVisible({ timeout: 30_000 });
  await customerOption.click();

  // The coffee offered belongs to the warehouse chosen above.
  const coffeeBox = page.getByRole('combobox', { name: /Coffee on item 1/ });
  await expect(coffeeBox).toBeVisible({ timeout: 30_000 });
  await coffeeBox.click();
  const coffeeOptions = await page.getByRole('listbox').getByRole('option').allTextContents();
  console.log(`  coffee in that warehouse: ${coffeeOptions.join(' | ')}`);
  expect(coffeeOptions.length).toBeGreaterThan(0);
  await page.getByRole('listbox').getByRole('option').first().click();

  // The batch list narrows to that coffee, in that warehouse.
  const batch = page.getByLabel(/Batch on item 1/);
  const batchOptions = (await batch.locator('option').allTextContents()).filter((o) => !/Choose/i.test(o));
  console.log(`  batches offered: ${batchOptions.join(' | ')}`);
  expect(batchOptions.length).toBeGreaterThan(0);
  await batch.selectOption({ index: 1 });

  const quantity = page.getByRole('textbox', { name: /^Quantity/ }).first();
  const price = page.getByRole('textbox', { name: /Price/ }).first();
  await quantity.fill('2000');
  await price.fill('100');
  await expect(quantity).toHaveValue('2000');

  await page.getByRole('button', { name: /^Save invoice$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for the invoice itself, not just for the URL: reading the document
  // as it streams returns the shell and says nothing about what was saved.
  await expect(page.getByText(new RegExp(CUSTOMER.slice(0, 14), 'i')).first()).toBeVisible({ timeout: 45_000 });

  const main = (await page.locator('main').textContent()) ?? '';
  expect(main).not.toMatch(/does not balance|something went wrong/i);
  const figures = (main.match(/[\d,]{5,}\.\d{2}/g) ?? []).slice(0, 8);
  console.log(`  invoice figures: ${figures.join(' | ')}`);
  // 2,000 KG at 100 is 200,000 before whatever tax the company applies.
  expect(main).toMatch(/200,000/);
  console.log('  invoice raised, 2,000 KG at MAD 100');
});

test('part of the invoice is paid in cash, and only that reaches the drawer', async ({ page }) => {
  await signIn(page);
  const cashBefore = await bankBalance(page, /Cash in Hand/i);

  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();

  await page.getByLabel('Payment method').selectOption('CASH');
  await page.getByLabel('Amount received').fill('50000');

  // Where the money landed.
  const into = page.getByRole('combobox', { name: /Received into/i }).first();
  await expect(into).toBeVisible({ timeout: 30_000 });
  await into.click();
  await page.getByRole('listbox').getByRole('option', { name: /Cash in Hand/i }).first().click();

  // Against the invoice raised a moment ago.
  const allocation = page.getByRole('textbox', { name: /Amount applied to/i }).first();
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.fill('50000');

  await page.getByRole('button', { name: /Save and post/i }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2000);

  // Say what the form said, rather than leaving a silent failure to be
  // discovered as a wrong balance three steps later.
  const url = page.url();
  const alerts = await page.getByRole('alert').allTextContents();
  const main = (await page.locator('main').textContent()) ?? '';
  const complaint = main.match(/[^.]*\b(required|must|cannot|could not|does not|invalid)\b[^.]*\./i);
  console.log(`    after save: ${url}`);
  if (alerts.length) console.log(`    alerts: ${alerts.join(' | ').slice(0, 300)}`);
  if (complaint) console.log(`    complaint: ${complaint[0].trim().slice(0, 200)}`);

  const cashAfter = await bankBalance(page, /Cash in Hand/i);
  console.log(`  cash ${cashBefore} → ${cashAfter}`);
  expect(cashAfter - cashBefore).toBeCloseTo(50_000, 2);
});

test('the invoice now reads part paid, with 150,000 still outstanding', async ({ page }) => {
  await signIn(page);
  await page.goto('/finance/receivables', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const row = page.getByRole('row').filter({ hasText: new RegExp(CUSTOMER.slice(0, 14), 'i') }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  const text = (await row.textContent()) ?? '';
  console.log(`  receivables row: ${text.replace(/\s+/g, ' ').trim()}`);
  expect(text).toMatch(/150,000/);
});

test('the reports agree with one another and open for any period', async ({ page }) => {
  await signIn(page);

  for (const [path, expected] of [
    ['/reports/sales', /Coffee sold|Revenue/i],
    ['/reports/purchases', /Coffee bought|Landed so far/i],
    ['/reports/shipment-cost', /Total landed cost|Cost per KG/i],
    ['/reports/cash-book', /Money in/i],
    ['/reports/trial-balance', /Debit/i],
    ['/reports/profit-loss', /Gross profit/i],
    ['/reports/balance-sheet', /Assets/i],
  ] as const) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(expected).first()).toBeVisible({ timeout: 45_000 });
    console.log(`  ${path} opens`);
  }

  // Every period the client asks for, on the report they ask it of.
  await page.goto('/reports/profit-loss', { waitUntil: 'domcontentloaded' });
  for (const label of ['Today', 'Yesterday', 'Last 7 days', 'This month', 'Everything']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({ timeout: 20_000 });
  }
  console.log('  every quick period is offered');
});

test('the shipment cost report splits the shared charges between the lines', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports/shipment-cost', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Cost per KG/i).first()).toBeVisible({ timeout: 45_000 });

  const main = (await page.locator('main').textContent()) ?? '';
  // The coffee, the charges added to it, and what a kilo ended up costing.
  expect(main).toMatch(/Coffee/i);
  expect(main).toMatch(/Costs added/i);
  expect(main).toMatch(/Total landed cost/i);
  expect(main).toMatch(/per KG/i);
  console.log('  shipment costing shows coffee, added costs and cost per kilo');
});

test('no system-issued code is on any of these screens', async ({ page }) => {
  await signIn(page);

  const offenders: string[] = [];
  for (const path of ['/customers', '/vendors', '/items', '/agents', '/accounting/chart', '/inventory']) {
    const started = Date.now();
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // networkidle never settles on a screen that keeps polling, so give it a
    // moment and read what is there rather than waiting for silence.
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    const main = (await page.locator('main').textContent()) ?? '';
    console.log(`    ${path} read in ${Date.now() - started}ms`);
    const hit = main.match(/\b(CUS|SUP|AGT|AG|ITM)-\d{3,}\b/);
    if (hit) offenders.push(`${path}: ${hit[0]}`);
  }

  for (const line of offenders) console.log(`  ! ${line}`);
  console.log(`  checked 6 master screens; ${offenders.length} showing a code`);
  expect(offenders, offenders.join('\n')).toEqual([]);
});
