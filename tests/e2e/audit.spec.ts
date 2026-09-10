import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * A sweep of the whole application, looking for the kinds of fault a client
 * finds first.
 *
 * Written after one of them did: a blank Coffee field showed "Too small:
 * expected string to have >=1 characters", which is Zod talking to a
 * programmer. That was one validator behind every reference field in the
 * system, and nothing would have caught it because every test asserted what a
 * page *should* say rather than watching for what it must never say.
 *
 * So this reads every page and every failed form the way a person does, and
 * fails on anything that looks like software talking to itself.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the audit.');
test.describe.configure({ mode: 'serial' });

/** Text that means the software has stopped speaking English. */
const DEVELOPER_SPEAK: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /expected string to have/i, why: 'a raw Zod message' },
  { pattern: /invalid_type|invalid_enum|invalid_string/i, why: 'a raw Zod issue code' },
  { pattern: /too small|too big/i, why: 'a raw Zod message' },
  { pattern: /\[object Object\]/, why: 'an object rendered as text' },
  { pattern: /:\s*undefined\b|\bundefined\s*(?:KG|USD|AED|MAD)\b/, why: 'an undefined value on screen' },
  { pattern: /\bNaN\b/, why: 'a broken calculation' },
  { pattern: /Invalid Date/, why: 'a broken date' },
  { pattern: /PrismaClient|prisma\./i, why: 'a database error' },
  { pattern: /at \w+ \(.*\.tsx?:\d+/, why: 'a stack trace' },
  { pattern: /Internal Server Error/i, why: 'an unhandled server error' },
  { pattern: /HTTP ERROR 5\d\d/i, why: 'a server error page' },
  { pattern: /ECONNREFUSED|ETIMEDOUT/, why: 'a connection error' },
];

/** Console noise worth failing on, as against the browser's usual chatter. */
const CONSOLE_IGNORE = [
  /Download the React DevTools/i,
  /favicon/i,
  /Autocomplete/i,
  /net::ERR_ABORTED/i,
];

const EVERY_PAGE = [
  '/dashboard', '/getting-started', '/purchases', '/purchases/new',   '/goods-receipts', '/sales', '/sales/new', '/shipments', '/loading',
  '/inventory', '/inventory/batches', '/inventory/shipments', '/inventory/transfers',
  '/inventory/movements', '/inventory/stock-counts', '/items', '/warehouses',
  '/finance/receipts', '/finance/payments', '/finance/expenses', '/finance/expenses/new',
  '/finance/cheques', '/finance/cash-bank', '/finance/receivables', '/finance/payables',
  '/finance/reconciliation', '/accounting/revaluation', '/accounting/journal/new',
  '/ledgers/customers', '/ledgers/vendors', '/reports', '/reports/profit-loss',
  '/reports/balance-sheet', '/reports/trial-balance', '/reports/cash-flow',
  '/reports/general-ledger', '/reports/journal', '/reports/reconciliation',
  '/reports/tax-return', '/reports/expenses', '/reports/analytics', '/reports/allocations',
  '/reports/stock-ageing', '/reports/business-overview', '/reports/financial-position',
  '/profitability', '/customers', '/vendors', '/agents', '/shipping-lines', '/ports',
  '/admin/users', '/admin/roles', '/admin/companies', '/admin/audit', '/admin/backups',
  '/expense-categories', '/settings', '/settings/tax', '/notifications', '/account',
];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

/** Everything a person can read on the page right now. */
async function visibleText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

function offences(text: string): string[] {
  return DEVELOPER_SPEAK.filter(({ pattern }) => pattern.test(text)).map(({ pattern, why }) => {
    const match = text.match(pattern);
    return `${why}: "${match?.[0] ?? ''}"`;
  });
}

test('no page shows the user anything written for a programmer', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);

  const problems: string[] = [];

  for (const path of EVERY_PAGE) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // Server components stream, so give the content a moment to arrive — and
    // give the connection pool a moment to give the connection back. Sweeping
    // sixty pages flat out exhausts a fifteen-client pooler, and an audit that
    // causes the fault it reports is worse than no audit.
    await page.waitForTimeout(600);

    const text = await visibleText(page);

    if (/this page could|something went wrong/i.test(text)) {
      problems.push(`${path}: rendered an error boundary`);
      continue;
    }

    for (const offence of offences(text)) problems.push(`${path}: ${offence}`);
  }

  expect(problems, problems.join('\n')).toEqual([]);
});

test('no page logs an error to the console', async ({ page }) => {
  test.setTimeout(600_000);

  const seen: string[] = [];
  const record = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (CONSOLE_IGNORE.some((pattern) => pattern.test(text))) return;
    seen.push(`${page.url().replace('http://localhost:3000', '')}: ${text.slice(0, 160)}`);
  };
  page.on('console', record);
  page.on('pageerror', (error) => {
    seen.push(`${page.url().replace('http://localhost:3000', '')}: ${error.message.slice(0, 160)}`);
  });

  await signIn(page);
  for (const path of EVERY_PAGE) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
  }

  expect(seen, seen.join('\n')).toEqual([]);
});

/**
 * Every entry form, saved empty.
 *
 * This is where a client meets the software at its worst: they press the
 * button before they have finished, and whatever comes back is the software's
 * whole personality.
 */
const FORMS = [
  { path: '/purchases/new', button: /Save as draft/i, name: 'purchase contract' },
  { path: '/sales/new', button: /Save as draft/i, name: 'sales invoice' },
  { path: '/finance/receipts/new', button: /Save/i, name: 'receipt' },
  { path: '/finance/payments/new', button: /Save/i, name: 'payment' },
  { path: '/finance/expenses/new', button: /Save/i, name: 'expense' },
  { path: '/accounting/journal/new', button: /Save/i, name: 'journal voucher' },
  { path: '/inventory/stock-counts/new', button: /Open count sheet/i, name: 'stock count' },
];

for (const form of FORMS) {
  test(`the ${form.name} form refuses in plain English`, async ({ page }) => {
    await signIn(page);
    await page.goto(form.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const save = page.getByRole('button', { name: form.button }).first();
    if ((await save.count()) === 0) {
      test.skip(true, `${form.path} has no ${form.button} button — probably a prerequisite gate.`);
      return;
    }

    await save.click();
    // The refusal comes back from the server for most of these.
    await page.waitForTimeout(2_500);

    const text = await visibleText(page);
    const found = offences(text);
    expect(found, `${form.path} said:\n${found.join('\n')}`).toEqual([]);

    // And it must actually say something, rather than failing silently.
    const stillOnForm = page.url().includes(form.path);
    if (stillOnForm) {
      const alert = page.getByRole('alert').first();
      const hasAlert = (await alert.count()) > 0;
      const hasInlineError = (await page.locator('[data-field-error="true"]').count()) > 0;
      expect(
        hasAlert || hasInlineError,
        `${form.path} refused to save but told the user nothing`,
      ).toBe(true);
    }
  });
}
