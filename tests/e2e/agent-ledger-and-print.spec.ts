import { test, expect, type Page } from '@playwright/test';

/**
 * The Morocco accounting brief, in the browser.
 *
 *   A  Invoice 15: MAD 126,000 invoiced, MAD 80,000 cash received — the
 *      invoice shows MAD 46,000 outstanding, the customer's ledger says the
 *      same, and nothing invented the difference.
 *   B  The MAD 46,000 collected by an agent appears ONCE on the agent's
 *      ledger, in MAD, with USD only as an equivalent, and once on the
 *      customer's ledger as a partial payment naming the invoice.
 *   C  General Ledgers: search the agent, open the ledger; search a
 *      customer, be sent to the Customer Ledger.
 *   D  Save pressed twice on a receipt records one receipt.
 *   E  The cash ledger prints six columns and fits the sheet.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run.');
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now().toString().slice(-5);
const CUSTOMER = `Bani Roastery ${STAMP}`;
const AGENT = `Radouan Agent ${STAMP}`;

let invoiceUrl = '';
let customerId = '';

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
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

async function money(text: string, currency: string): Promise<number[]> {
  return [...text.matchAll(new RegExp(`${currency}\\s(-?[\\d,]+\\.\\d{2})`, 'g'))].map((m) => Number(m[1].replace(/,/g, '')));
}

test('an invoice of MAD 126,000 is raised, and MAD 80,000 cash is received against it', async ({ page }) => {
  await signIn(page);

  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.getByRole('button', { name: /^Add Customer$/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel(/customer name/i).fill(CUSTOMER);
  await sheet.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });

  await page.getByLabel('Warehouse on item 1', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel(/Batch on item 1/).selectOption({ index: 1 });
  // 2,100 KG at 60 = MAD 126,000
  await page.getByRole('textbox', { name: /^Quantity/ }).first().fill('2100');
  await page.getByRole('textbox', { name: /Price/ }).first().fill('60');
  await page.getByLabel(/^Memo/).fill('Sale of Screen 12 to Bani');
  // Save invoice posts it when the user can approve sales.
  await page.getByRole('button', { name: /^Save invoice$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { timeout: 60_000 });
  invoiceUrl = page.url();
  await expect(page.getByRole('main')).toContainText(/Posted/, { timeout: 30_000 });

  // The customer's id, for their ledger later.
  const ledgerLink = page.getByRole('link', { name: CUSTOMER }).first();
  customerId = ((await ledgerLink.getAttribute('href')) ?? '').split('/').pop() ?? '';

  // MAD 80,000 in cash, applied to the invoice, with a memo.
  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Payment method').selectOption('CASH');
  const allocation = page.getByRole('textbox', { name: /Amount applied to/i }).first();
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.fill('80000');
  await page.getByLabel('Amount received').fill('80000');
  await page.getByLabel(/^Memo/).fill('Cash received from Bani against the invoice');
  await page.getByRole('button', { name: /Save and post/i }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(2000);

  // A: the invoice says 46,000 is still owed — no advance, no phantom.
  await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/Outstanding/, { timeout: 45_000 });
  const invoiceText = (await page.locator('main').textContent()) ?? '';
  expect(invoiceText).toMatch(/46,000\.00/);
  expect(invoiceText).toMatch(/Partially Paid/i);
  expect(invoiceText).not.toMatch(/advance/i);
  console.log('  invoice: MAD 126,000 raised, MAD 80,000 received, MAD 46,000 outstanding');
});

test('the MAD 46,000 is collected by an agent — recorded once, and Save pressed twice does not double it', async ({ page }) => {
  await signIn(page);

  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.getByRole('combobox', { name: /customer/i }).first().click();
  await page.keyboard.type(CUSTOMER.slice(0, 14));
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Payment method').selectOption('AGENT_COLLECTION');

  // A new agent, opened from the form.
  await page.getByRole('combobox', { name: /^Agent/ }).click();
  await page.getByRole('button', { name: /\+ Add New Agent/ }).click();
  await page.getByLabel(/^Agent name/i).fill(AGENT);
  await page.getByRole('dialog').getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });

  const allocation = page.getByRole('textbox', { name: /Amount applied to/i }).first();
  await expect(allocation).toBeVisible({ timeout: 30_000 });
  await allocation.fill('46000');
  await page.getByLabel('Amount received').fill('46000');
  await page.getByLabel(/^Memo/).fill('Agent collection from Radouan against the invoice');

  // D: a double click on Save and post.
  const save = page.getByRole('button', { name: /Save and post/i });
  await save.dblclick();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(3000);

  // One receipt for this customer's collection, however many times it was sent.
  await page.goto('/finance/receipts', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const rows = page.locator('main table tbody tr').filter({ hasText: CUSTOMER.slice(0, 14) }).filter({ hasText: /46,000\.00/ });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main table tbody tr').filter({ hasText: CUSTOMER.slice(0, 14) }).filter({ hasText: /46,000\.00/ })).toHaveCount(1);
  console.log('  agent collection: one receipt after a double click and a reload');
});

test('the agent ledger shows the collection once, in MAD, with USD only as an equivalent', async ({ page }) => {
  await signIn(page);

  // C: General Ledgers finds the agent, and opens their ledger.
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Search ledgers').fill(AGENT.slice(0, 12));
  const hit = page.getByRole('link', { name: AGENT, exact: true }).first();
  await expect(hit).toBeVisible({ timeout: 20_000 });
  const row = page.getByTestId('ledger-entry').filter({ has: hit }).first();
  await expect(row).toContainText(/MAD 46,000\.00/);
  await expect(row).toContainText(/USD Eq/);
  await row.getByRole('link', { name: /Open ledger/ }).click();
  await page.waitForURL(/\/agents\/[\w-]+$/, { timeout: 30_000 });

  // B: one line, MAD, the invoice named, the memo carried, USD beside it.
  const ledger = page.getByTestId('agent-ledger');
  await expect(ledger).toBeVisible({ timeout: 30_000 });
  const lines = ledger.locator('tbody tr').filter({ hasText: /46,000\.00/ });
  await expect(lines).toHaveCount(1);
  const line = lines.first();
  await expect(line.getByTestId('agent-ledger-type')).toContainText(/Customer Payment Collected/);
  await expect(line).toContainText(/INV \d+/);
  await expect(line).toContainText(/Agent collection from Radouan/);
  const text = (await line.textContent()) ?? '';
  expect((await money(text, 'MAD')).filter((n) => n === 46000).length).toBeGreaterThanOrEqual(1);
  const usd = await money(text, 'USD');
  expect(usd.length).toBe(1);
  expect(usd[0]).toBeGreaterThan(1000);
  expect(usd[0]).toBeLessThan(46000);
  // Nowhere on the page is the collection stated as USD 46,000.
  expect((await page.locator('main').textContent()) ?? '').not.toMatch(/USD 46,000\.00/);
  console.log(`  agent ledger: one line, MAD 46,000.00, USD Eq. ${usd[0]}`);

  // And on the customer's ledger it is a partial payment against the invoice, in MAD.
  await page.goto(`/ledgers/customers/${customerId}?currency=MAD`, { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  await expect(main).toContainText(/Partial Payment/, { timeout: 30_000 });
  const types = await main.getByTestId('ledger-type').allTextContents();
  expect(types.filter((t) => /Partial Payment/.test(t)).length).toBe(2);
  expect(types.filter((t) => /^Invoice$/.test(t.trim())).length).toBe(1);
  await expect(main).toContainText(/Cash received from Bani/);
  await expect(main).toContainText(/Collected by/);
  await expect(main).toContainText(/Memo/);
  await expect(main.getByRole('columnheader', { name: /^Invoice$/ })).toBeVisible();
  console.log('  customer ledger: Invoice, Partial Payment ×2, memos and collector shown');

  // A customer typed into General Ledgers is sent to the Customer Ledger.
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Search ledgers').fill(CUSTOMER.slice(0, 12));
  const elsewhere = page.getByTestId('ledger-elsewhere');
  await expect(elsewhere).toBeVisible({ timeout: 20_000 });
  await expect(elsewhere).toContainText(/Customer Ledger/);
});

test('the agent is the subledger of Agent Clearing, not a second balance', async ({ page }) => {
  await signIn(page);

  // Agent Balances states the control account and what the agents explain.
  await page.goto('/ledgers/agents', { waitUntil: 'domcontentloaded' });
  const reconciliation = page.getByTestId('agent-clearing-reconciliation');
  await expect(reconciliation).toBeVisible({ timeout: 30_000 });
  const text = (await reconciliation.innerText()).replace(/\s+/g, ' ');
  const figures = [...text.matchAll(/MAD\s([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, '')));
  expect(figures).toHaveLength(2);
  // Control account = what the agents hold, so nothing is counted twice.
  expect(figures[0]).toBeCloseTo(figures[1], 2);
  expect(text).toMatch(/never counted twice/i);

  // The Agent Clearing account itself opens in MAD and points at the agents.
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Search ledgers').fill('Agent Clearing');
  await page.getByRole('link', { name: /Open ledger/ }).first().click();
  await page.waitForURL(/\/reports\/general-ledger/, { timeout: 30_000 });
  const main = page.getByRole('main');
  await expect(main).toContainText(/held by named agents/i, { timeout: 30_000 });
  await expect(main).toContainText(/MAD/);
  // The collection is MAD on this ledger — never stated as USD.
  const ledgerText = (await main.innerText()).replace(/\s+/g, ' ');
  const mad = [...ledgerText.matchAll(/MAD\s([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, '')));
  expect(mad.some((n) => n === 46000)).toBe(true);
  expect(ledgerText).not.toMatch(/USD 46,000\.00/);
  console.log('  agent clearing: control equals the agent subledger, shown in MAD');
});

test('he hands over more than he collected: the excess is classified, never guessed', async ({ page }) => {
  await signIn(page);

  // Open his page from General Ledgers, as a user would.
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Search ledgers').fill(AGENT.slice(0, 12));
  const hit = page.getByRole('link', { name: AGENT, exact: true }).first();
  await expect(hit).toBeVisible({ timeout: 20_000 });
  await hit.click();
  await page.waitForURL(/\/agents\//, { timeout: 30_000 });
  const agentUrl = page.url();

  // He is holding MAD 46,000, and the page says so in the client's words.
  const main = page.getByRole('main');
  await expect(main).toContainText(new RegExp(`${AGENT.split(' ')[0]}.*owes the company`, 'i'), { timeout: 30_000 });

  // MAD 200,000 handed over: the form names the 154,000 and will not take it
  // until somebody says what it is.
  await page.getByTestId('agent-received-open').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByLabel(/Paid into/i).selectOption({ index: 1 });
  await sheet.getByLabel(/^Amount/i).fill('200000');
  await expect(page.getByTestId('excess-choice')).toContainText(/MAD 154,000\.00/, { timeout: 10_000 });
  await sheet.getByRole('button', { name: /Record money received/i }).click();
  await expect(sheet).toContainText(/Say what the extra MAD 154,000\.00 is/i, { timeout: 10_000 });

  // Told it is his own money, it settles what he held and lends the rest.
  await page.getByTestId('excess-loan').check();
  await sheet.getByLabel(/^Memo/i).fill('Handed over 200,000: 46,000 collected, the rest his own money');
  await sheet.getByRole('button', { name: /Record money received/i }).click();
  await expect(sheet).toHaveCount(0, { timeout: 30_000 });

  await page.goto(agentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const summary = (await main.innerText()).replace(/\s+/g, ' ');
  expect(summary).toMatch(/The company owes .* MAD 154,000\.00/i);
  expect(summary).not.toMatch(/USD 200,000\.00/);
  console.log('  hand-over: MAD 46,000 settled, MAD 154,000 booked as his loan');

  // The tabs slice the same ledger: loans on their own, clearing back to nil.
  await page.getByTestId('agent-tab-loans').click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByTestId('agent-ledger')).toContainText(/154,000\.00/, { timeout: 20_000 });
  await expect(page.getByTestId('agent-ledger')).not.toContainText(/46,000\.00/);
  const direction = await page.getByTestId('agent-ledger-direction').first().innerText();
  expect(direction).toMatch(new RegExp(`(${AGENT.split(' ')[0]}|FID) owes`, 'i'));

  await page.getByTestId('agent-tab-clearing').click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const clearing = page.getByTestId('agent-ledger');
  await expect(clearing).toContainText(/46,000\.00/, { timeout: 20_000 });
  const balances = [...((await clearing.innerText()).matchAll(/MAD\s(-?[\d,]+\.\d{2})/g))].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  // What he collected and what he handed over, ending at nothing held.
  expect(balances.some((n) => n === 46000)).toBe(true);
  console.log('  tabs: loans and clearing shown separately, each with its own balance');
});

test('setting the two balances against each other is asked for, never automatic', async ({ page }) => {
  await signIn(page);
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Search ledgers').fill(AGENT.slice(0, 12));
  await page.getByRole('link', { name: AGENT, exact: true }).first().click();
  await page.waitForURL(/\/agents\//, { timeout: 30_000 });

  // He holds nothing right now, so there is nothing to set off and the
  // button says so by being unavailable.
  await expect(page.getByTestId('agent-offset-open')).toBeDisabled({ timeout: 30_000 });
  const text = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
  expect(text).toMatch(/nothing is set against anything else until someone asks for it/i);
  console.log('  offset: nothing to settle, and nothing settled on its own');
});

test('the ledger list shows him once, and opens to the accounts behind him', async ({ page }) => {
  await signIn(page);
  await page.goto('/ledgers', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // Simple is what opens: one row for the man, not one per account.
  await page.getByLabel('Search ledgers').fill(AGENT.split(' ')[0]);
  const rows = page.getByTestId('ledger-entry');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  const row = rows.first();
  await expect(row).toContainText(AGENT);

  // What he owes and what FID owes him, said in words.
  const summary = (await row.getByTestId('ledger-party-summary').innerText()).replace(/\s+/g, ' ');
  expect(summary).toMatch(new RegExp(`${AGENT.split(' ')[0]} owes FID: MAD [\\d,]+\\.\\d{2}`, 'i'));
  expect(summary).toMatch(/FID owes .*: MAD [\d,]+\.\d{2}/i);
  expect(summary).toMatch(/Net position: MAD [\d,]+\.\d{2} (receivable|payable)/i);
  console.log('  ledger list:', summary);

  // The accounts are underneath him, not beside him.
  await row.getByTestId('ledger-expand').click();
  const children = page.getByTestId('ledger-children');
  await expect(children).toBeVisible({ timeout: 10_000 });
  await expect(children).toContainText(new RegExp(`Loan from ${AGENT.split(' ')[0]}`, 'i'));
  await expect(children).toContainText(/each still its own account in the books/i);

  // The accountant's view lists those accounts on their own, as the books hold them.
  await page.getByTestId('ledger-view-accounting').click();
  await page.getByLabel('Search ledgers').fill(`Loan from ${AGENT.split(' ')[0]}`);
  await expect(page.getByTestId('ledger-entry').first()).toContainText(/Loan from/i, { timeout: 10_000 });
  console.log('  accounting view: the loan account is listed on its own');
});

test('the cash ledger prints six columns that fit the sheet, with the memo on it', async ({ page }) => {
  await signIn(page);
  await page.goto('/reports/cash-book', { waitUntil: 'domcontentloaded' });
  const cash = page.getByRole('link', { name: /Cash in Hand/i }).first();
  if (await cash.count()) await cash.click();
  const table = page.getByTestId('cash-book');
  await expect(table).toBeVisible({ timeout: 30_000 });

  // The headers the client asked for, and none of the ones he did not.
  const headers = (await table.locator('thead th').allTextContents()).map((h) => h.trim()).filter(Boolean);
  expect(headers.slice(0, 6)).toEqual(['Date', 'Reference', 'Memo', 'Cash In', 'Cash Out', 'Balance']);
  expect(headers).not.toContain('Who');
  expect(headers).not.toContain('Source');
  expect(headers).not.toContain('Description');
  await expect(table).toContainText(/Cash received from/);

  // Print options are offered.
  await page.getByRole('button', { name: 'Print options' }).click();
  for (const name of ['Auto', 'Portrait', 'Landscape', 'Fit to width', 'Actual size']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  // On paper: portrait A4 is 210mm wide; at 96dpi that is 794px. Rendered
  // as print, the table must be no wider than the sheet's printable width,
  // and the action column must be gone.
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    document.documentElement.dataset.printScale = 'fit';
    document.documentElement.dataset.printOrientation = 'portrait';
  });
  await page.setViewportSize({ width: 794, height: 1123 });
  const box = await table.boundingBox();
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(box!.x + box!.width).toBeLessThanOrEqual(794 + 1);
  expect(bodyWidth).toBeLessThanOrEqual(794 + 1);
  const printedHeaders = await table.locator('thead th:visible').allTextContents();
  expect(printedHeaders.map((h) => h.trim()).filter(Boolean)).toEqual(['Date', 'Reference', 'Memo', 'Cash In', 'Cash Out', 'Balance']);
  // Compact: a row is a few points high, so fifty-plus fit a page.
  const rowHeight = await table.locator('tbody tr').first().evaluate((el) => el.getBoundingClientRect().height);
  expect(rowHeight).toBeLessThan(22);
  console.log(`  cash ledger print: table ${Math.round(box!.width)}px wide on a 794px sheet, rows ${rowHeight.toFixed(1)}px`);
  await page.emulateMedia({ media: 'screen' });
});
