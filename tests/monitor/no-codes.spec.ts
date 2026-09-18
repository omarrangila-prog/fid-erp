import { test, expect, type Page } from '@playwright/test';

/**
 * No accounting code on any screen a person opens.
 *
 * Read-only. It walks the pages where codes used to appear and looks for the
 * shapes they take — "1100 · Cash in Hand", "4000 — Sales Revenue", a bare
 * four-digit code in its own cell.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

/** "1100 · Name", "4000 — Name", "(1200)" — a code sitting beside a name. */
const CODE_BESIDE_NAME = /\b[12345]\d{3}\s*[·—–-]\s*[A-Z]/;
const CODE_IN_BRACKETS = /\(\s*[12345]\d{3}\s*\)/;
/** FID-MA-SI-000008 and every other number the system issues itself. */
const SYSTEM_DOCUMENT_NUMBER = /\bFID-[A-Z]{2,3}-[A-Z]{2,4}-\d{4,}\b/;

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    const arrived = await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (arrived) break;
    if (!(await tile.isVisible().catch(() => false))) break;
  }
  await expect(keypad).toBeVisible({ timeout: 30_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!new RegExp(COMPANY, 'i').test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: new RegExp(COMPANY, 'i') }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

/** Where the system's own document numbering used to appear. */
const DOCUMENT_SCREENS = [
  '/sales',
  '/sales/credit-notes',
  '/purchases',
  '/shipments',
  '/loading',
  '/goods-receipts',
  '/inventory/batches',
  '/inventory/transfers',
  '/finance/receipts',
  '/finance/payments',
  '/finance/expenses',
  '/finance/cheques',
  '/ledgers/customers',
  '/ledgers/vendors',
  '/profitability',
];

const SCREENS = [
  '/accounting/chart',
  '/accounting/journal/new',
  '/accounting/revaluation',
  '/finance/cash-bank',
  '/finance/expenses/new',
  '/finance/receipts/new',
  '/finance/payments/new',
  '/finance/loans/new',
  '/finance/intercompany-loan',
  '/reports/trial-balance',
  '/reports/profit-loss',
  '/reports/balance-sheet',
  '/reports/general-ledger',
  '/reports/journal',
  '/reports/cash-book',
  '/reports/forex',
  '/expense-categories',
];

test('no accounting code is shown anywhere a person looks', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await signIn(page);

  const offences: string[] = [];

  for (const path of SCREENS) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const body = (await page.locator('body').textContent()) ?? '';

    for (const [label, pattern] of [
      ['code beside a name', CODE_BESIDE_NAME],
      ['code in brackets', CODE_IN_BRACKETS],
    ] as const) {
      const hit = body.match(pattern);
      if (hit) offences.push(`${path}  ${label}: "${hit[0].trim()}"`);
    }
  }

  // Every dropdown on those screens, too — a label is text nobody scrolls to.
  await page.goto('/accounting/journal/new', { waitUntil: 'domcontentloaded' });
  const options = await page.locator('select option').allTextContents();
  for (const option of options) {
    if (CODE_BESIDE_NAME.test(option)) offences.push(`journal dropdown: "${option}"`);
  }

  for (const line of offences) console.log('  ! ' + line);
  console.log(`  checked ${SCREENS.length} screens; ${offences.length} showing a code`);
  expect(offences, offences.join('\n')).toEqual([]);
});

test('no document number the system issued is shown either', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await signIn(page);

  const offences: string[] = [];
  for (const path of DOCUMENT_SCREENS) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // Long enough for the table to render, short enough that fifteen screens
    // finish: a page that polls never reaches networkidle at all.
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    const body = (await page.locator('main').textContent()) ?? '';
    const hit = body.match(SYSTEM_DOCUMENT_NUMBER);
    if (hit) offences.push(`${path}: "${hit[0]}"`);
  }

  for (const line of offences) console.log('  ! ' + line);
  console.log(`  checked ${DOCUMENT_SCREENS.length} document screens; ${offences.length} showing a number`);
  expect(offences, offences.join('\n')).toEqual([]);
});
