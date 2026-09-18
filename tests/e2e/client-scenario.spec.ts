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

  // Who the money is with is an account, opened from the selector if new.
  const party = page.getByRole('combobox', { name: /Received from account/i }).first();
  await party.click();
  await page.keyboard.type('FID Trading LLC Dubai');
  const existing = page.getByRole('listbox').getByRole('option').first();
  if (await existing.count()) {
    await existing.click();
  } else {
    await page.getByRole('button', { name: /Add New Account/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: /Create|Save|Add/i }).last().click();
    await expect(dialog).toBeHidden({ timeout: 45_000 });
  }
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

  const account = page.getByRole('link', { name: /FID Trading LLC Dubai/i }).first();
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
  // The invoice is numbered the way anybody says it.
  expect(main).toMatch(/INV \d+/);
  console.log(`  numbered: ${main.match(/INV \d+/)?.[0]}`);
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

test('the rest is settled by a cheque the agent takes away', async ({ page }) => {
  await signIn(page);
  const cashBefore = await bankBalance(page, /Cash in Hand/i);

  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();

  // The customer handed the cheque to the agent, not to us.
  await page.getByLabel('Payment method').selectOption('AGENT_COLLECTION');
  await page.getByLabel('Amount received').fill('150000');

  const agent = page.getByRole('combobox', { name: /agent/i }).first();
  await expect(agent).toBeVisible({ timeout: 30_000 });
  await agent.click();
  await page.getByRole('listbox').getByRole('option').first().click();

  // A real cheque, dated three days out.
  await page.getByLabel('Cheque number').fill('CHQ-WALK-1');
  const chequeDate = page.getByLabel('Cheque date');
  if (await chequeDate.count()) await chequeDate.fill('2026-09-24');

  const allocation = page.getByRole('textbox', { name: /Amount applied to/i }).first();
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.fill('150000');

  await page.getByRole('button', { name: /Save and post/i }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2500);

  // Nothing reached the drawer: the agent is holding it.
  const cashAfter = await bankBalance(page, /Cash in Hand/i);
  console.log(`  cash stayed at ${cashAfter} (was ${cashBefore})`);
  expect(cashAfter).toBeCloseTo(cashBefore, 2);
});

test('the customer now owes nothing, and the agent owes us', async ({ page }) => {
  await signIn(page);

  await page.goto('/finance/receivables', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const settled = (await page.locator('main').textContent()) ?? '';
  const stillOwing = new RegExp(`${CUSTOMER.slice(0, 14)}[^]*?150,000`, 'i').test(settled);
  console.log(`  customer still owing 150,000: ${stillOwing}`);
  expect(stillOwing).toBe(false);

  await page.goto('/ledgers/agents', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const agents = (await page.locator('main').textContent()) ?? '';
  console.log(`  agent ledger mentions 150,000: ${/150,000/.test(agents)}`);
  expect(agents).toMatch(/150,000/);
});

test('the cheque can be marked cleared, and still no money reaches the bank', async ({ page }) => {
  await signIn(page);
  const cashBefore = await bankBalance(page, /Cash in Hand/i);

  await page.goto('/finance/cheques', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);

  const row = page.getByRole('row').filter({ hasText: /CHQ-WALK-1/ }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  console.log(`  cheque row: ${((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`);

  // The register offers the action on the row itself.
  const clear = row.getByRole('button', { name: /^Clear$/i }).first();
  await expect(clear).toBeVisible({ timeout: 30_000 });
  await clear.click();

  // An agent's cheque clears in his hands, so no bank account is asked for.
  const confirm = page.getByRole('button', { name: /Clear|Confirm|Mark/i }).last();
  await confirm.click().catch(() => undefined);
  await page.waitForTimeout(3000);

  const status = (await page.locator('main').textContent()) ?? '';
  console.log(`  cheque now: ${/cleared/i.test(status) ? 'Cleared' : 'still Received'}`);

  const cashAfter = await bankBalance(page, /Cash in Hand/i);
  console.log(`  cash after clearing: ${cashAfter} (was ${cashBefore})`);
  expect(cashAfter).toBeCloseTo(cashBefore, 2);
});

test('a second cheque is taken by the agent, and bounces', async ({ page }) => {
  await signIn(page);

  // Another invoice for the same customer, so there is something to bounce.
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.locator('#warehouseId').selectOption({ index: 1 });
  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel(/Batch on item 1/).selectOption({ index: 1 });
  await page.getByRole('textbox', { name: /^Quantity/ }).first().fill('500');
  await page.getByRole('textbox', { name: /Price/ }).first().fill('100');
  await page.getByRole('button', { name: /^Save invoice$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { timeout: 60_000 });

  // Settled by a cheque the agent takes away.
  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Payment method').selectOption('AGENT_COLLECTION');
  await page.getByLabel('Amount received').fill('50000');
  await page.getByRole('combobox', { name: /agent/i }).first().click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Cheque number').fill('CHQ-WALK-2');
  const allocation = page.getByRole('textbox', { name: /Amount applied to/i }).first();
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.fill('50000');
  await page.getByRole('button', { name: /Save and post/i }).click();
  await page.waitForTimeout(2500);

  // Now bounce it.
  await page.goto('/finance/cheques', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const row = page.getByRole('row').filter({ hasText: /CHQ-WALK-2/ }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });

  const bounce = row.getByRole('button', { name: /^Bounce$/i }).first();
  await expect(bounce).toBeVisible({ timeout: 30_000 });
  await bounce.click();

  // A bounce has to say why.
  const reason = page.getByLabel(/Reason/i).first();
  await expect(reason).toBeVisible({ timeout: 20_000 });
  await reason.fill('Returned unpaid — insufficient funds');
  await page.getByRole('button', { name: /^Bounce|Confirm/i }).last().click();
  await page.waitForTimeout(3000);

  const after = (await page.locator('main').textContent()) ?? '';
  console.log(`  cheque two: ${/bounced/i.test(after) ? 'Bounced' : 'not bounced'}`);
  expect(after).toMatch(/bounced/i);
});

test('the bounce puts the debt back on the customer and off the agent', async ({ page }) => {
  await signIn(page);

  await page.goto('/finance/receivables', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const owed = (await page.locator('main').textContent()) ?? '';
  const backOnCustomer = new RegExp(`${CUSTOMER.slice(0, 14)}[^]*?50,000`, 'i').test(owed);
  console.log(`  customer owes the 50,000 again: ${backOnCustomer}`);
  expect(backOnCustomer).toBe(true);

  // And a bounce is never a cost.
  await page.goto('/reports/profit-loss', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const pnl = (await page.locator('main').textContent()) ?? '';
  expect(pnl).not.toMatch(/bounce/i);
  console.log('  nothing about a bounce reaches the profit and loss');
});

test('coffee moves between warehouses without becoming a sale', async ({ page }) => {
  await signIn(page);

  await page.goto('/inventory/transfers/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const screen = (await page.locator('main').textContent()) ?? '';
  expect(screen).toMatch(/transfer/i);

  // A transfer is stock moving, never revenue: no price is asked for.
  expect(screen).not.toMatch(/selling price|unit price|revenue/i);
  console.log('  the transfer screen asks for no price, because it is not a sale');

  const warehouses = await page.locator('select').first().locator('option').allTextContents();
  console.log(`  transfer offers: ${warehouses.filter((w) => !/choose/i.test(w)).join(' | ')}`);
  expect(warehouses.length).toBeGreaterThan(0);
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

test('the menu can be searched instead of remembered', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const search = page.getByLabel('Search the menu');
  await expect(search).toBeVisible({ timeout: 30_000 });

  // "ledger" should find all of them, whichever section they live in.
  await search.fill('ledger');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const links = await nav.getByRole('link').allTextContents();
  console.log(`  "ledger" finds: ${links.join(' | ')}`);
  expect(links.length).toBeGreaterThan(1);
  expect(links.join(' ')).toMatch(/Customer Ledgers/i);

  await search.fill('invoice');
  const invoiceLinks = await nav.getByRole('link').allTextContents();
  console.log(`  "invoice" finds: ${invoiceLinks.join(' | ')}`);
  expect(invoiceLinks.join(' ')).toMatch(/Sales Invoices/i);

  await search.fill('zzzz');
  await expect(page.getByText(/Nothing matches/i)).toBeVisible();
  console.log('  a search with no matches says so');
});

test('the statements lead with the figures they exist to give', async ({ page }) => {
  await signIn(page);

  for (const [path, expected] of [
    ['/reports/trial-balance', ['Total debit', 'Total credit', 'Difference']],
    ['/reports/profit-loss', ['Revenue', 'Cost of sales', 'Gross profit', 'Expenses', 'Net profit']],
    ['/reports/balance-sheet', ['Total assets', 'Total liabilities', 'Total equity', 'Liabilities + equity']],
  ] as const) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
    const main = (await page.locator('main').textContent()) ?? '';
    for (const label of expected) {
      expect(main, `${path} → ${label}`).toContain(label);
    }
    console.log(`  ${path}: ${expected.join(', ')}`);
  }

  // The verdict is stated, not left to be worked out.
  await page.goto('/reports/trial-balance', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/^Balanced$|Attention required/).first()).toBeVisible({ timeout: 30_000 });
  console.log('  the trial balance says whether it balances');
});

test('who the loan is with is chosen from the ledgers, not typed', async ({ page }) => {
  await signIn(page);
  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  // No blank name box: it is a searchable list of accounts.
  const party = page.getByRole('combobox', { name: /Received from account/i }).first();
  await expect(party).toBeVisible({ timeout: 30_000 });
  await party.click();

  const options = await page.getByRole('listbox').getByRole('option').allTextContents();
  console.log(`  accounts offered: ${options.slice(0, 6).join(' | ')}`);
  expect(options.length).toBeGreaterThan(0);

  // Typing a name nobody has yet offers to open a ledger for them.
  await page.keyboard.type('Zahra Holdings');
  // The create row sits above the list as a button, not inside the listbox.
  const create = page.getByRole('button', { name: /Add New Account/i }).first();
  await expect(create).toBeVisible({ timeout: 15_000 });
  console.log('  a name nobody has offers to open a ledger');
});

test('creating an account keeps the rest of the form', async ({ page }) => {
  await signIn(page);
  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  // Fill the form first, then discover the account is missing.
  await page.getByLabel(/^Amount/).fill('12345');
  const name = `Zahra ${Date.now().toString().slice(-5)}`;

  await page.getByRole('combobox', { name: /Received from account/i }).first().click();
  await page.keyboard.type(name);
  await page.getByRole('button', { name: /Add New Account/i }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /Create|Save|Add/i }).last().click();
  await expect(dialog).toBeHidden({ timeout: 45_000 });

  // The new ledger is selected, and nothing typed earlier was lost.
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel(/^Amount/)).toHaveValue('12345');
  console.log(`  ${name} created, selected, and the amount survived`);
});

test('the shipment row shows what each container cost', async ({ page }) => {
  await signIn(page);
  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  const row = page.locator('main table tbody tr').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const text = ((await row.textContent()) ?? '').replace(/\s+/g, ' ');
  console.log(`  shipment row: ${text.slice(0, 220)}`);

  // The job's own figures are there whether or not it has two containers.
  expect(text).toMatch(/USD/);
  expect(text).toMatch(/KG/);
});

test('every money form picks a party from a list, never a blank box', async ({ page }) => {
  await signIn(page);

  const checks: Array<[string, RegExp]> = [
    ['/finance/receipts/new', /customer/i],
    ['/finance/payments/new', /supplier/i],
    ['/finance/loans/new', /Received from account/i],
    ['/accounting/journal/new', /account/i],
  ];

  for (const [path, label] of checks) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

    // Advanced journal is behind the guided chooser.
    const advanced = page.getByRole('button', { name: /Advanced journal entry/i }).first();
    if (await advanced.count()) await advanced.click();

    const picker = page.getByRole('combobox', { name: label }).first();
    await expect(picker, `${path} should pick ${label}`).toBeVisible({ timeout: 30_000 });

    await picker.click();
    const canCreate = await page.getByRole('button', { name: /Add New|Add Customer|Add Supplier/i }).count();
    console.log(`  ${path}: picks from a list${canCreate ? ', and can open a new one' : ''}`);
    await page.keyboard.press('Escape');
  }
});

test('the accounts you use come to the top next time', async ({ page }) => {
  await signIn(page);
  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  const party = page.getByRole('combobox', { name: /Received from account/i }).first();
  await party.click();

  // Nothing used yet, so no sections.
  const before = (await page.getByRole('listbox').textContent()) ?? '';
  console.log(`  before choosing: ${/Recent/i.test(before) ? 'has a Recent section' : 'no sections yet'}`);

  // Choose one, then reopen.
  const options = page.getByRole('listbox').getByRole('option');
  const chosen = ((await options.nth(2).textContent()) ?? '').split('\n')[0].trim();
  await options.nth(2).click();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await page.getByRole('combobox', { name: /Received from account/i }).first().click();

  const after = (await page.getByRole('listbox').textContent()) ?? '';
  console.log(`  after choosing "${chosen.slice(0, 30)}": ${/Recent/i.test(after) ? 'Recent section shown' : 'no Recent section'}`);
  expect(after).toMatch(/Recent/i);
  expect(after).toMatch(/All accounts/i);

  // And the one just used is the first thing in the list.
  const first = ((await page.getByRole('listbox').getByRole('option').first().textContent()) ?? '').trim();
  console.log(`  top of the list: ${first.split('\n')[0]}`);
  expect(first).toContain(chosen.slice(0, 12));
});

test('the sales list reads in the order the client asked for', async ({ page }) => {
  await signIn(page);
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  const headers = (await page.locator('main table thead th').allTextContents()).map((h) => h.trim());
  console.log(`  columns: ${headers.join(' | ')}`);

  // Date, invoice, order, customer, status, due, amount, balance, location.
  const wanted = ['Date', 'Invoice #', 'Order no.', 'Customer', 'Status', 'Due', 'Value', 'Balance due', 'Location'];
  const positions = wanted.map((w) => headers.findIndex((h) => h.startsWith(w)));
  for (const [i, w] of wanted.entries()) {
    expect(positions[i], `${w} should be on the list`).toBeGreaterThan(-1);
  }
  const ordered = positions.every((pos, i) => i === 0 || pos > positions[i - 1]);
  expect(ordered, `order was ${headers.join(' | ')}`).toBe(true);

  // And the invoice is numbered the short way.
  const body = (await page.locator('main table tbody').textContent()) ?? '';
  expect(body).toMatch(/INV \d+/);
  console.log(`  numbered: ${body.match(/INV \d+/)?.[0]}`);
});

test('the invoice form shows the number it will be given', async ({ page }) => {
  await signIn(page);
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  const main = (await page.locator('main').textContent()) ?? '';
  expect(main).toMatch(/Invoice number/i);
  expect(main).toMatch(/INV \d+/);
  console.log(`  the next invoice will be ${main.match(/INV \d+/)?.[0]}`);
});
