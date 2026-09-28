import { test, expect, type Browser, type Page, type Request } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * PIN-only sign-in for an agent, end to end (the brief's own test).
 *
 * The owner creates RADOUAN MOHAMMED with the Agent role and a PIN of his own,
 * linked to his agent record. Radouan then signs in with the PIN alone and:
 *
 *   sees his permitted pages and not Accounting, Settings or Administration;
 *   creates an invoice for his own customer, and edits it;
 *   has no Delete button — and the delete request itself, replayed with his
 *   session, is refused by the server;
 *   cannot open an invoice that is not his.
 *
 * Then the owner signs in with the owner's PIN and has full access. A second
 * user given the same PIN is refused.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
const TAKEN = [ADMIN_PIN, process.env.DUBAI_STAFF_PIN, process.env.MOROCCO_STAFF_PIN];
const AGENT_PIN = ['5827', '6391', '4718', '3952'].find((pin) => !TAKEN.includes(pin))!;
const RUN = Date.now().toString(36).slice(-5);
const CUSTOMER = `Radouan Client ${RUN}`;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

async function pinIn(page: Page, pin: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible({ timeout: 45_000 });
  for (const digit of pin) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (page.url().includes('select-company')) {
    await chooseCompany(page, /FID Trading International SARL/);
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

async function logout(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
}

async function owner(browser: Browser) {
  const page = await browser.newPage();
  await pinIn(page, ADMIN_PIN);
  return page;
}

async function addUser(page: Page, name: string, pin: string) {
  await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Add user$/ }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Full name').fill(name);
  await sheet.getByLabel('PIN', { exact: true }).fill(pin);
  await sheet.getByLabel('Confirm PIN').fill(pin);
  await sheet.getByRole('checkbox', { name: /^Agent\b/ }).check();
  await sheet.getByLabel('Agent (own data only)').selectOption({ label: 'E2E Settlement Agent · FID-MA' });
  await sheet.getByRole('button', { name: /^(Save|Create user)$/ }).click();
  return sheet;
}

let invoiceA = '';
let invoiceB = '';

test('the owner creates RADOUAN MOHAMMED as an Agent with a PIN of his own', async ({ browser }) => {
  const page = await owner(browser);
  // A new installation may not have the Agent role yet: the owner adds it in one click.
  await page.goto('/admin/roles', { waitUntil: 'domcontentloaded' });
  const add = page.getByTestId('add-standard-roles');
  if (await add.isVisible().catch(() => false)) await add.click();

  const sheet = await addUser(page, 'RADOUAN MOHAMMED', AGENT_PIN);
  await expect(sheet).toHaveCount(0, { timeout: 30_000 });
  const row = page.getByRole('row').filter({ hasText: 'RADOUAN MOHAMMED' }).first();
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('Set');

  // His permissions: invoices View, Create, Edit — not Delete.
  await page.goto((await row.locator('a[href^="/admin/users/"]').first().getAttribute('href'))!, { waitUntil: 'domcontentloaded' });
  const sales = page.getByTestId('grid-row-sales');
  await expect(sales.getByRole('checkbox', { name: 'Sales invoices: view' })).toBeChecked({ timeout: 30_000 });
  await expect(sales.getByRole('checkbox', { name: 'Sales invoices: create' })).toBeChecked();
  await expect(sales.getByRole('checkbox', { name: 'Sales invoices: edit' })).toBeChecked();
  await expect(sales.getByRole('checkbox', { name: 'Sales invoices: delete' })).not.toBeChecked();

  // The same PIN cannot be given to anyone else.
  const again = await addUser(page, `Someone Else ${RUN}`, AGENT_PIN);
  await expect(again).toContainText('This PIN is already assigned. Please choose another PIN.', { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  await logout(page);
});

test('Radouan signs in with the PIN alone and sees only what he was given', async ({ browser }) => {
  const page = await browser.newPage();
  await pinIn(page, AGENT_PIN);
  await expect(page.getByTestId('user-menu')).toContainText('RADOUAN MOHAMMED');
  await expect(page.getByTestId('agent-own-panel')).toBeVisible({ timeout: 30_000 });

  const nav = page.locator('aside nav[aria-label="Main"]');
  for (const hidden of ['Accounting', 'Administration']) {
    await expect(nav.getByRole('button', { name: new RegExp(`^${hidden}\\b`) })).toHaveCount(0);
  }
  for (const route of ['/accounting/journal/new', '/settings', '/admin/users', '/reports/trial-balance']) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page, route).toHaveURL(/\/unauthorized/, { timeout: 30_000 });
  }
  // His ledger only: the agents list opens straight onto his own.
  await page.goto('/agents', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E Settlement Agent', { timeout: 30_000 });
  await logout(page);
});

async function draftInvoice(page: Page) {
  await page.goto('/sales/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const form = page.getByRole('main');
  // His customer: picked if he already has one, added if not.
  const customer = form.getByRole('combobox', { name: /customer/i }).first();
  if (!(await form.getByText(CUSTOMER).count())) {
    const choose = async () => {
      await customer.click();
      await page.keyboard.type(CUSTOMER.slice(0, 12), { delay: 20 });
      const option = page.getByRole('listbox').getByRole('option').filter({ hasText: CUSTOMER }).first();
      if (await option.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
        await option.click();
        return true;
      }
      await page.keyboard.press('Escape');
      return false;
    };
    if (!(await choose())) {
      await page.getByRole('button', { name: /^Add Customer$/ }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByLabel(/customer name/i).fill(CUSTOMER);
      await sheet.getByRole('button', { name: /^Save$/ }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
    }
  }
  await form.getByLabel('Warehouse on item 1', { exact: true }).selectOption({ index: 1 });
  await form.getByRole('combobox', { name: /Coffee on item 1/ }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await form.getByLabel(/Batch on item 1/).selectOption({ index: 1 });
  await form.getByRole('textbox', { name: /^Quantity/ }).first().fill('60');
  await form.getByRole('textbox', { name: /Price/ }).first().fill('6.00');
  await form.getByRole('button', { name: /^Save (as draft|invoice)$/ }).click();
  await page.waitForURL(/\/sales\/(?!new)[\w-]+$/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return page.url();
}

test('Radouan creates and edits invoices for his own customer; there is no Delete', async ({ browser }) => {
  const page = await browser.newPage();
  await pinIn(page, AGENT_PIN);
  invoiceA = await draftInvoice(page);
  invoiceB = await draftInvoice(page);
  await expect(page.getByRole('main')).toContainText(CUSTOMER);
  await expect(page.getByTestId('record-history')).toContainText('Created by RADOUAN MOHAMMED');

  // Edit works.
  await page.goto(`${invoiceA}/edit`, { waitUntil: 'domcontentloaded' });
  const price = page.getByRole('main').getByRole('textbox', { name: /Price/ }).first();
  await price.fill('6.50');
  await page.getByRole('main').getByRole('button', { name: /^Save changes$/ }).click();
  await page.waitForURL(new RegExp(`${new URL(invoiceA).pathname}$`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.getByTestId('record-history')).toContainText('Last edited by RADOUAN MOHAMMED');

  // No Delete anywhere on it, and not on the list either.
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  const rows = page.locator('main table').first().locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  // Only his: the fixture's invoice to another customer is not on his list, nor opens.
  await expect(page.getByRole('main')).not.toContainText('E2E Torréfacteur Casablanca');
  await logout(page);
});

test('the delete request itself, sent with his session, is refused on the server', async ({ browser }) => {
  // The owner deletes invoice B through the screen; the request is kept.
  const boss = await owner(browser);
  let captured: Request | null = null;
  boss.on('request', (request) => {
    if (request.method() === 'POST' && request.headers()['next-action'] && (request.postData() ?? '').includes(new URL(invoiceB).pathname.split('/').pop()!)) {
      captured = request;
    }
  });
  await boss.goto(invoiceB, { waitUntil: 'domcontentloaded' });
  await boss.getByRole('main').getByRole('button', { name: /^Delete (draft|invoice)$/ }).first().click();
  const confirm = boss.getByRole('dialog');
  const reason = confirm.getByLabel(/why is this invoice being deleted/i);
  if (await reason.count()) await reason.fill('Owner test of the delete request');
  await confirm.getByRole('button', { name: /^Delete (draft|invoice)$/ }).click();
  await boss.waitForURL(/\/sales\/?$/, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  expect(captured, 'the delete request was seen').not.toBeNull();
  const request = captured as unknown as Request;

  // Radouan sends the very same request, for invoice A.
  const page = await browser.newPage();
  await pinIn(page, AGENT_PIN);
  const idB = new URL(invoiceB).pathname.split('/').pop()!;
  const idA = new URL(invoiceA).pathname.split('/').pop()!;
  const headers = Object.fromEntries(Object.entries(request.headers()).filter(([key]) => !['cookie', 'content-length'].includes(key)));
  const response = await page.request.fetch(request.url(), {
    method: 'POST',
    headers,
    data: (request.postData() ?? '').replaceAll(idB, idA),
  });
  const body = await response.text();
  expect(body).toMatch(/"ok":false/);
  expect(body).toMatch(/permission|not allowed|forbidden/i);

  // Invoice A is still there and still his.
  await page.goto(invoiceA, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main')).toContainText(CUSTOMER, { timeout: 30_000 });
  await expect(page.getByRole('main')).not.toContainText(/deleted/i);
  await logout(page);

  // And the owner, on the owner's PIN, has everything.
  await boss.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(boss).toHaveURL(/\/settings/);
  await boss.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  await expect(boss).toHaveURL(/\/accounting\/journal\/new/);
});
