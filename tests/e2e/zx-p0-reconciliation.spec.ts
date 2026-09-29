import { test, expect, type Locator, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The P0 reconciliation, on screen.
 *
 * A MAD drawer reads the same MAD figure on Cash & Bank, on its own page, in
 * the General Ledger, on the Balance Sheet and in the Chart of Accounts — MAD
 * first, the USD equivalent smaller underneath, never the other way round.
 * The statements lead with MAD. And an unpaid cost set off against an agent
 * reads Settled, leaves the unpaid total, moves the agent's balance by exactly
 * its amount, and moves no cash.
 *
 * Named to run after the other suites, when the fixture's drawers and agents
 * have transactions on them.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
const RUN = Date.now().toString(36).slice(-5);
const MEMO = `E2E P0 set-off ${RUN}`;
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

async function choose(page: Page, combobox: Locator, text?: string | RegExp) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await combobox.click();
    const options = page.getByRole('listbox').getByRole('option');
    const option = text ? options.filter({ hasText: text }).first() : options.first();
    const shown = await option.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    if (shown) {
      const label = (await option.innerText()).trim();
      if (await option.click({ timeout: 5_000 }).then(() => true).catch(() => false)) return label;
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
  throw new Error('the picker never stayed open long enough to choose');
}

const amountOf = (text: string) => Number((/-?[\d,]+\.\d{2}/.exec(text)?.[0] ?? '0').replace(/,/g, ''));

let page: Page;
test.beforeAll(async ({ browser }) => {
  // A context of its own, so a second tab can share the sign-in.
  page = await (await browser.newContext()).newPage();
  await signIn(page);
});
test.afterAll(async () => page?.context().close());

test('a MAD drawer reads the same MAD figure on Cash & Bank, its page, the General Ledger, the Balance Sheet and the Chart of Accounts', async () => {
  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  const rows = page.getByRole('main').locator('table tbody tr').filter({ has: page.locator('td', { hasText: /^MAD$/ }) });
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  const drawers: Array<{ href: string; primary: string; secondary: string }> = [];
  for (const row of await rows.all()) {
    const primary = (await row.locator('[data-dual-amount] > span').first().innerText()).trim();
    const secondary = (await row.locator('[data-dual-amount] > span').nth(1).innerText().catch(() => '')).trim();
    const href = (await row.locator('a[href^="/finance/cash-bank/"]').first().getAttribute('href')) ?? '';
    // MAD first, the USD equivalent smaller and marked as one.
    expect(primary).toMatch(/^MAD [\d,-]+\.\d{2}$/);
    if (amountOf(primary) !== 0) expect(secondary).toMatch(/^≈ USD/);
    drawers.push({ href, primary, secondary });
  }
  const checked = drawers.filter((d) => amountOf(d.primary) !== 0).slice(0, 2);
  test.skip(checked.length === 0, 'No MAD drawer has a balance in the fixture.');

  for (const drawer of checked) {
    await page.goto(drawer.href, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-share-fact="Closing balance"]')).toHaveText(drawer.primary, { timeout: 45_000 });
    const gl = page.getByRole('link', { name: 'View general ledger' });
    const glHref = (await gl.getAttribute('href')) ?? '';
    const glId = /account=([\w-]+)/.exec(glHref)?.[1] ?? '';
    expect(glId).not.toBe('');

    await gl.click();
    await page.waitForURL(/\/reports\/general-ledger/, { waitUntil: 'domcontentloaded' });
    const summary = page.getByTestId('ledger-summary');
    await expect(summary).toBeVisible({ timeout: 45_000 });
    const closing = (await summary.locator('dd').nth(3).innerText()).trim();
    expect(closing).toMatch(/^MAD /);
    // The ledger says a credit balance with Cr; the drawer with a minus sign. The same figure.
    expect(signed(closing)).toBeCloseTo(amountOf(drawer.primary), 2);

    // Cash & Bank counts every dated entry; so does a balance sheet dated past them all.
    await page.goto('/reports/balance-sheet?asOf=2099-12-31', { waitUntil: 'domcontentloaded' });
    const line = page.locator('tr', { has: page.locator(`a[href*="account=${glId}"]`) }).first();
    await expect(line).toBeVisible({ timeout: 45_000 });
    const cell = (await line.locator('td').nth(1).innerText()).trim();
    expect(cell.split('\n')[0]).toBe(drawer.primary);
    expect(cell).toMatch(/≈ USD/);

    await page.goto('/accounting/chart', { waitUntil: 'domcontentloaded' });
    const chartRow = page.locator('tr', { has: page.locator(`a[href*="${glId}"]`) }).first();
    if (await chartRow.count()) {
      const balance = (await chartRow.locator('td').filter({ hasText: /^MAD / }).last().innerText()).trim();
      expect(balance.split('\n')[0]).toBe(drawer.primary);
    }
  }
});

test('the statements lead with MAD, the books’ own currency, with the USD equivalent under it', async () => {
  await page.goto('/reports/trial-balance', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(/Total debit\s*MAD [\d,]+\.\d{2}/, { timeout: 45_000 });
  await expect(page.getByRole('main')).toContainText(/≈ USD/);

  await page.goto('/reports/profit-loss', { waitUntil: 'domcontentloaded' });
  const net = page.locator('tr', { hasText: 'Net profit' }).first();
  await expect(net).toBeVisible({ timeout: 45_000 });
  expect((await net.locator('td').nth(1).innerText()).trim()).toMatch(/^-?MAD [\d,-]+\.\d{2}\n≈ USD/);

  await page.goto('/reports/balance-sheet', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('balance-sheet-equation')).toContainText(/Assets MAD [\d,]+\.\d{2} = liabilities MAD/, { timeout: 45_000 });
  await expect(page.getByText('Assets = Liabilities + Equity')).toBeVisible();
});

test('an unpaid cost set off against an agent: Settled, off the unpaid total, the agent down by exactly its amount, no cash moved', async () => {
  // A cost booked to be paid later, owed to nobody in particular.
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const form = page.getByRole('main');
  await choose(page, form.getByRole('combobox', { name: /contract \/ shipment/i }), 'E2E-PO-MA-1');
  await choose(page, form.getByRole('combobox', { name: /^category/i }));
  await form.getByLabel(/^Amount/).fill('1234');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('9.85');
  await form.getByLabel(/^Memo/).fill(MEMO);
  await form.getByRole('button', { name: /save and post/i }).click();
  await page.waitForURL(/\/finance\/expenses\/(?!new)[\w-]+/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const expenseUrl = page.url();
  await expect(page.getByTestId('expense-payment-status')).toContainText(/Unpaid/, { timeout: 30_000 });

  const cashBefore = await cashInHand();
  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  const totalBefore = amountOf(await page.getByTestId('unpaid-total').innerText());

  const row = page.getByTestId('unpaid-schedule').getByRole('row').filter({ hasText: MEMO }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByTestId('settle-expense').click();
  const dialog = page.getByTestId('settle-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Today$/ }).click();
  await dialog.getByLabel(/Ledger adjustment/).check();
  const sources = dialog.locator('#setOffAgainst');
  test.skip((await sources.count()) === 0, 'No agent owes FID in the fixture.');
  const label = await choose(page, sources, /Agent receivable/);
  const agentName = label.split(' — ')[0].trim();
  await expect(page.getByTestId('setoff-preview')).toContainText(/Cash impact\s*MAD 0\.00/);

  // The agent's balance before, from his own page.
  const agentPage = await page.context().newPage();
  // Agent Balances lists every agent with a balance, each opening his own ledger.
  await agentPage.goto('/ledgers/agents', { waitUntil: 'domcontentloaded' });
  const agentLink = agentPage.locator(`main a[href^="/agents/"]`, { hasText: agentName }).first();
  await expect(agentLink).toBeAttached({ timeout: 45_000 });
  const agentUrl = ((await agentLink.getAttribute('href')) ?? '').split('?')[0];
  await agentPage.goto(agentUrl, { waitUntil: 'domcontentloaded' });
  const netBefore = signed(await agentPage.getByTestId('agent-net-balance').innerText());

  await page.getByTestId('post-settlement').click();
  await expect(page.getByText(/Settlement posted\.|Adjustment posted\./).first()).toBeVisible({ timeout: 90_000 });

  await page.goto(expenseUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('expense-payment-status')).toContainText(/Paid/, { timeout: 30_000 });
  await expect(page.getByTestId('expense-outstanding')).toHaveText(/MAD 0\.00/);

  await page.goto('/finance/unpaid-expenses', { waitUntil: 'domcontentloaded' });
  expect(amountOf(await page.getByTestId('unpaid-total').innerText())).toBeCloseTo(totalBefore - 1234, 2);
  expect(await cashInHand()).toBeCloseTo(cashBefore, 2);

  await agentPage.goto(agentUrl, { waitUntil: 'domcontentloaded' });
  expect(signed(await agentPage.getByTestId('agent-net-balance').innerText())).toBeCloseTo(netBefore - 1234, 2);
  await agentPage.close();
});

/** The agent's net as a signed number: Dr (owes FID) positive, Cr negative. */
function signed(text: string): number {
  const value = amountOf(text);
  return /\bCr\b/.test(text) ? -value : value;
}

async function cashInHand(): Promise<number> {
  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('main').locator('table tbody tr').filter({ has: page.locator('td', { hasText: /^MAD$/ }) }).filter({ hasText: /Cash/ }).first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  return amountOf(await row.locator('[data-dual-amount] > span').first().innerText());
}
