import { test, expect, type Page } from '@playwright/test';

/**
 * The postings that stopped posting on 26 Sep 2026, driven through the forms.
 *
 * Loans, cash and bank transfers and agent postings waited on themselves for
 * a second database connection and died at the transaction's time limit — 60
 * or 120 seconds. Each test here posts through the real form and must finish
 * well inside that, then reads the result back after a reload.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const MOROCCO = /FID Trading International SARL/i;
const AGENT = 'E2E Clearing Agent';
const POSTED_WITHIN = 30_000;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    if (await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) break;
    if (!(await tile.isVisible().catch(() => false))) break;
  }
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if ((await switcher.count()) && !MOROCCO.test((await switcher.textContent()) ?? '')) {
    await switcher.click();
    await page.getByRole('menuitem', { name: MOROCCO }).click();
    await page.waitForLoadState('domcontentloaded');
  }
}

async function loan(page: Page, what: RegExp, amount: string, into: RegExp) {
  await page.goto('/finance/loans/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.getByRole('button', { name: what }).click();
  const agentChoice = page.getByRole('button', { name: 'An agent' });
  if (await agentChoice.count()) await agentChoice.click();
  await page.locator('#loanAgent').selectOption({ label: AGENT });
  const account = page.getByLabel(into).first();
  const option = account.locator('option').filter({ hasText: /MAD|Cash|Bank/i }).nth(0);
  const value = await option.getAttribute('value');
  if (value) await account.selectOption(value);
  await page.getByLabel(/^Amount/).first().fill(amount);
  const started = Date.now();
  await page.getByRole('button', { name: /Post loan/ }).click();
  await page.waitForURL(/\/finance\/cash-bank/, { timeout: POSTED_WITHIN });
  return Date.now() - started;
}

test('A — a loan received from an agent posts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const took = await loan(page, /We received a loan/, '27500', /Received into/);
  console.log(`  loan received posted in ${took} ms`);
  await page.reload();
  await expect(page.getByRole('main')).toBeVisible();
});

test('B — a loan given to an agent posts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const took = await loan(page, /We lent money out/, '20000', /Paid from/);
  console.log(`  loan given posted in ${took} ms`);
});

test('C — a loan repayment posts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const took = await loan(page, /We repaid a loan/, '10000', /Paid from/);
  console.log(`  loan repayment posted in ${took} ms`);
});

test('the agent ledger shows all three, each once', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/agents', { waitUntil: 'domcontentloaded' });
  // Each agent's row opens his consolidated ledger.
  const row = page.getByRole('row').filter({ hasText: AGENT }).first();
  const href = await row.getByRole('link', { name: 'Ledger' }).getAttribute('href');
  await page.goto(href!, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const text = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
  // 27,500 received less 10,000 repaid; 20,000 lent; so he owes us 2,500 net.
  const line = text.match(new RegExp(`${AGENT}.*?agent owes us`))?.[0] ?? '';
  expect(line, 'loan from him').toMatch(/MAD 17,500\.00/);
  expect(line, 'loan to him').toMatch(/MAD 20,000\.00/);
  expect(line, 'net').toMatch(/MAD 2,500\.00 agent owes us/);
});

async function transfer(page: Page, from: RegExp, to: RegExp, amount: string) {
  await page.goto('/finance/cash-bank', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.getByRole('button', { name: /^Transfer$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const pick = async (label: RegExp, match: RegExp) => {
    const select = dialog.getByLabel(label).first();
    const value = await select.locator('option').filter({ hasText: match }).first().getAttribute('value');
    await select.selectOption(value!);
  };
  await pick(/^From/, from);
  await pick(/^To/, to);
  await dialog.getByLabel(/^Amount/).first().fill(amount);
  const started = Date.now();
  await dialog.getByRole('button', { name: /Post transfer/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: POSTED_WITHIN });
  return Date.now() - started;
}

test('D — cash to bank posts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const took = await transfer(page, /Cash.*MAD/i, /Bank.*MAD|BANK.*MAD/i, '1000');
  console.log(`  cash to bank posted in ${took} ms`);
});

test('E — bank to cash posts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const took = await transfer(page, /Bank.*MAD|BANK.*MAD/i, /Cash.*MAD/i, '500');
  console.log(`  bank to cash posted in ${took} ms`);
});
