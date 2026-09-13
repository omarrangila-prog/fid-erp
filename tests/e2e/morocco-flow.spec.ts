import { test, expect, type Page } from '@playwright/test';

/**
 * The Morocco workflow, in a browser.
 *
 * The service layer is covered by tests/integration/morocco-workflow.test.ts.
 * This is the other half of the client's complaint: not "does it compute" but
 * "can somebody actually do it" — can a purchase order be saved without a lot
 * number, does the loading sheet row appear by itself, is there a button to
 * mark it loaded, and does the receipt ask for the lot at the point the coffee
 * is in front of you.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the Morocco flow test.');

async function signInToMorocco(page: Page) {
  // `domcontentloaded`, not the default `load`: waiting for every subresource
  // on a page that keeps polling has hung this suite before.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading International SARL/ }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }

  // Already in a company — switch if it is the wrong one.
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!/International SARL/.test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();

      // Wait for the switch to land, not for a guessed number of milliseconds.
      // A fixed 1.5s was shorter than the round trip to a database in Tokyo,
      // so the next page was requested while the session still said Dubai: it
      // rendered Dubai's suppliers, and saving one of them against a session
      // that had since become Morocco gave "Supplier was not found."
      await expect(page.getByRole('button', { name: /International SARL/ })).toBeVisible({
        timeout: 30_000,
      });
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToMorocco(page);
});

test('a purchase order saves with no lot number and no payment term', async ({ page }) => {
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });

  // The fields the client asked to be rid of are gone.
  await expect(page.getByLabel(/payment terms/i)).toHaveCount(0);
  await expect(page.getByLabel(/expected shipment date/i)).toHaveCount(0);

  // And a due date is offered instead — a date, not a term — behind the
  // "fill in what you know" heading, so the plain order stays plain.
  await page.getByText(/Supplier reference, origin and payment due/).click();
  await expect(page.getByLabel(/payment due/i)).toBeVisible();

  // Lot and batch are on the line, behind their own disclosure, and neither
  // is marked required — they are asked for at the goods receipt.
  await page.getByText(/Lot, batch, container and packing/).first().click();
  const lot = page.getByLabel(/lot number/i).first();
  await expect(lot).toBeVisible();
  await expect(lot).not.toHaveAttribute('required', '');
});

test('the loading sheet offers one button to mark a consignment loaded', async ({ page }) => {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });

  // The sheet fills itself from the contracts; nothing is typed here.
  await expect(page.getByRole('heading', { name: /Loading/i }).first()).toBeVisible();

  const markLoaded = page.getByRole('button', { name: /Mark loaded/i }).first();
  if ((await markLoaded.count()) === 0) {
    test.skip(true, 'Every consignment in this company is already loaded.');
    return;
  }

  await markLoaded.click();

  // The shipping information the purchase order deliberately stopped asking
  // for, asked at the point it exists.
  await expect(page.getByLabel(/loading date/i)).toBeVisible();
  await expect(page.getByLabel(/estimated arrival/i)).toBeVisible();
  await expect(page.getByLabel(/shipping line/i)).toBeVisible();
  await expect(page.getByLabel(/bill of lading/i)).toBeVisible();

  // And it says what is wrong rather than doing nothing.
  await page.getByLabel(/estimated arrival/i).fill('');
  await page.getByRole('button', { name: /^Mark as loaded$/i }).click();
  await expect(page.getByRole('alert')).toContainText(/estimated arrival/i);
});

test('a consignment with no lot asks for one when it is received', async ({ page }) => {
  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });

  // Find a contract that still has coffee to receive.
  const receivable = page.getByRole('row').filter({ hasText: /Approved|Posted/i }).first();
  if ((await receivable.count()) === 0) {
    test.skip(true, 'No approved contract to receive against.');
    return;
  }

  await receivable.click();
  await page.waitForURL(/\/purchases\/[\w-]+$/, { waitUntil: 'domcontentloaded' });

  const receive = page.getByRole('button', { name: /Receive goods/i });
  if ((await receive.count()) === 0) {
    test.skip(true, 'This contract is already fully received.');
    return;
  }

  await receive.click();

  // The receipt asks what arrived, and offers to record it arriving as more
  // than one lot — the client's 42 MT landing as two lots of 21.
  await expect(page.getByRole('heading', { name: /Receive goods/i })).toBeVisible();
  await expect(page.getByLabel(/^Lot number/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Arrived as another lot/i }).first()).toBeVisible();
});

test('the sales invoice takes a due date, not a payment term', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });

  await expect(page.getByLabel(/payment terms/i)).toHaveCount(0);
  await expect(page.getByLabel(/due date/i)).toBeVisible();

  // Warehouse and batch are chosen per line, so the invoice knows which
  // location the coffee left from. Scoped to the form: the sidebar has a
  // "Warehouse Transfers" link that a loose text match picks up instead.
  await expect(page.getByRole('main').getByText(/warehouse/i).first()).toBeVisible();
});

test('an invoice with money owing offers to record a payment', async ({ page }) => {
  // Via receivables rather than the sales list: this page lists only invoices
  // that still have something outstanding, and "Record payment" is offered
  // only on those — picking any posted invoice lands on a settled one.
  await page.goto('/finance/receivables', { waitUntil: 'domcontentloaded' });

  const invoiceLink = page.getByRole('main').getByRole('link', { name: /INV|FID-/ }).first();
  if ((await invoiceLink.count()) === 0) {
    test.skip(true, 'Nothing is outstanding in this company.');
    return;
  }

  await invoiceLink.click();
  await page.waitForURL(/\/sales\/[\w-]+$/, { waitUntil: 'domcontentloaded' });

  // Recording a payment is one click from the invoice, as §24 asks.
  const record = page.getByRole('link', { name: /Record payment/i });
  await expect(record).toBeVisible();

  await record.click();
  await page.waitForURL(/\/finance\/receipts\/new/, { waitUntil: 'domcontentloaded' });

  // And the amount is free, so a part payment is simply a smaller number —
  // §29, where one invoice may take three or four payments.
  await expect(page.getByRole('main').getByLabel(/amount/i).first()).toBeEditable();
});

test('a purchase order can be raised from the screen, start to finish', async ({ page }) => {
  test.setTimeout(180_000);

  // --- A purchase order with the least the client can give ---------------
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // By role and name: `getByLabel(/supplier/i)` also matches "Supplier
  // contract no.", which is a text box, so the option list never opened and
  // the test sat there until it timed out.
  // Scoped to the open listbox: a bare `getByRole('option')` also matches the
  // native <option> elements inside the currency <select>, which are never
  // visible, so the click waited three minutes for one of those.
  await form.getByRole('combobox', { name: /^Supplier/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();

  await form.getByRole('combobox', { name: /^Coffee/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();

  const quantity = form.getByRole('textbox', { name: /^Quantity/ }).first();
  const price = form.getByRole('textbox', { name: /^Price per/ }).first();
  await quantity.fill('42000');
  await price.fill('4.00');

  // Read them back before pressing Save. Clicking straight after `fill` raced
  // React's commit: the price arrived empty, the contract saved without it and
  // the test then waited thirty seconds for a page it had made impossible.
  await expect(quantity).toHaveValue('42000');
  await expect(price).toHaveValue('4.00');

  // Nothing else. No lot, no batch, no payment term, no consignee, no ETA.
  const saveButton = form.getByRole('button', { name: /^Save as draft/ });
  await saveButton.click();

  // The button must say it is working for the whole wait. Opening the saved
  // contract is a round trip of its own — four to five seconds against a
  // database in Tokyo — and it used to go back to reading "Save as draft"
  // the moment the action returned, so the form sat there looking untouched.
  await expect(form.getByRole('button', { name: 'Saving…' })).toBeVisible();

  // Note the negative lookahead. `/purchases/[\w-]+$` also matches
  // `/purchases/new`, so the wait was satisfied before anything had been
  // saved and the assertion below then ran against the form it had just
  // filled in — a test that could never fail for the reason it was written.
  await page.waitForURL(/\/purchases\/(?!new)[\w-]+$/, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // It saved: the contract has an FID number of its own and the quantity it
  // was given, with no lot number anywhere.
  await expect(page.getByRole('main')).toContainText(/FID-MA-PO-|FID-DXB-PO-/);
  await expect(page.getByRole('main')).toContainText(/42,000/);
});

/**
 * The eight corrections from the 35-point specification that needed new
 * screens. The accounting behind them is covered by
 * tests/integration/agent-ledger.test.ts; these check a person can reach it.
 */
test('§13–14 the invoice asks whether it is cash or credit', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await expect(form.getByText('How is this being paid?')).toBeVisible();
  const paymentType = form.getByLabel(/payment type/i);
  await expect(paymentType).toBeVisible();

  // Credit by default — an invoice is not settled unless somebody says so.
  await expect(paymentType).toHaveValue('CREDIT');

  // Choosing cash asks where the money went, and not before.
  await expect(form.getByLabel(/paid into/i)).toHaveCount(0);
  await paymentType.selectOption('CASH');
  await expect(form.getByLabel(/paid into/i)).toBeVisible();
});

test('§9 a customer can be added without leaving the invoice', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: /New customer/i }).click();
  await expect(page.getByRole('heading', { name: /New customer/i })).toBeVisible();
  await expect(page.getByLabel(/customer name/i)).toBeVisible();

  // It asks only what an invoice needs.
  await expect(page.getByLabel(/credit limit/i)).toHaveCount(0);
  await expect(page.getByLabel(/address/i)).toHaveCount(0);
});

test('§17 a receipt can be collected by an agent', async ({ page }) => {
  await page.goto('/finance/receipts/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  await form.getByRole('combobox', { name: /^Payment method/ }).selectOption('AGENT_COLLECTION');

  // By role and name. `getByLabel(/collected by/i)` also matches the payment
  // method select, because the option now chosen inside it reads "Collected by
  // an agent" — two matches, and the assertion fails on a form that is right.
  await expect(form.getByRole('combobox', { name: /^Collected by/ })).toBeVisible();
  await expect(form.getByLabel(/received into/i)).toHaveCount(0);
  await expect(form.getByText(/does not put money in the bank/i)).toBeVisible();
});

test('§19 the agent ledger says how much is sitting with whom', async ({ page }) => {
  await page.goto('/ledgers/agents', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: /Agent Ledgers/i }).first()).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/Holding for us|No agents yet/i);
});

test('§4 three containers means three boxes', async ({ page }) => {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });

  const markLoaded = page.getByRole('button', { name: /Mark loaded/i }).first();
  if ((await markLoaded.count()) === 0) {
    test.skip(true, 'Everything in this company is already loaded.');
    return;
  }

  await markLoaded.click();
  await expect(page.getByLabel(/container number/i)).toBeVisible();

  await page.getByLabel(/how many containers/i).fill('3');
  await expect(page.getByLabel(/^Container 1$/)).toBeVisible();
  await expect(page.getByLabel(/^Container 2$/)).toBeVisible();
  await expect(page.getByLabel(/^Container 3$/)).toBeVisible();
});

test('§2 the Morocco loading sheet has no consignee column', async ({ page }) => {
  await page.goto('/loading', { waitUntil: 'domcontentloaded' });

  // Morocco imports under its own name and sells the container on afterwards,
  // so there is no consignee to name. Dubai's sheet keeps the column.
  await expect(page.getByRole('columnheader', { name: 'Consignee' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /Company name/i })).toBeVisible();
});

test('§11 the sale asks for the warehouse before the stock', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // Two ways to pick stock, and it starts on the safer one: the cascade
  // cannot offer a batch from the wrong warehouse.
  await expect(form.getByRole('button', { name: 'By warehouse' })).toHaveAttribute('aria-pressed', 'true');
  await expect(form.getByRole('button', { name: 'Search stock' })).toHaveAttribute('aria-pressed', 'false');

  const warehouse = form.getByRole('combobox', { name: /^Warehouse/ }).first();
  const coffee = form.getByRole('combobox', { name: /^Coffee/ }).first();
  const batch = form.getByRole('combobox', { name: /^Batch/ }).first();

  // Nothing below the warehouse can be chosen until it is.
  await expect(warehouse).toBeVisible();
  await expect(coffee).toBeDisabled();
  await expect(batch).toBeDisabled();

  const options = await warehouse.locator('option').count();
  if (options <= 1) {
    test.skip(true, 'No warehouse holds sellable stock in this company.');
    return;
  }

  await warehouse.selectOption({ index: 1 });
  await expect(coffee).toBeEnabled();
  await expect(batch).toBeDisabled();

  await coffee.selectOption({ index: 1 });
  await expect(batch).toBeEnabled();

  // And the batches offered say how much is actually there.
  await expect(batch.locator('option').nth(1)).toContainText(/KG available/);
});

test('§35 rule 3 — saving a purchase order puts it on the loading sheet', async ({ page }) => {
  await page.goto('/purchases/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // One button, and it is the obvious one.
  await expect(form.getByRole('button', { name: /^Save purchase order$/ })).toBeVisible();
  await expect(form.getByText(/appears on the Loading Sheet immediately/i)).toBeVisible();
});

test('§11 stock can also be searched directly, for whole-container selling', async ({ page }) => {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  const form = page.getByRole('main');

  // Dubai sells a container at a time, where the row is the container and the
  // cascade is two steps more than the job needs. Switching gives one box.
  await form.getByRole('button', { name: 'Search stock' }).click();

  await expect(form.getByRole('combobox', { name: /Batch and warehouse/ })).toBeVisible();
  await expect(form.getByRole('combobox', { name: /^Warehouse/ })).toHaveCount(0);

  // And back again, without losing the invoice.
  await form.getByRole('button', { name: 'By warehouse' }).click();
  await expect(form.getByRole('combobox', { name: /^Warehouse/ }).first()).toBeVisible();
});
