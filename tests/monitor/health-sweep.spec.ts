import { test, expect, type Page, type ConsoleMessage, type Response } from '@playwright/test';

/**
 * A read-only walk of the running application.
 *
 * Opens every screen a person uses and reports what a person would hit: a
 * page that errored, a request that failed, a message in the console, a
 * spinner that never resolved. It clicks nothing that writes — no Save, no
 * Post, no Delete — because it runs against the client's live books while
 * they are working in them.
 *
 * It fails loudly rather than quietly: the point is to find the problem
 * before the client reports it.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

/** Every screen in the sidebar, in the order a person meets them. */
const SCREENS: Array<{ path: string; expect?: RegExp }> = [
  { path: '/dashboard' },
  { path: '/sales' },
  { path: '/sales/new' },
  { path: '/sales/credit-notes' },
  { path: '/purchases' },
  { path: '/purchases/new' },
  { path: '/purchases/debit-notes' },
  { path: '/loading' },
  { path: '/shipments' },
  { path: '/goods-receipts' },
  { path: '/inventory' },
  { path: '/inventory/batches' },
  { path: '/inventory/movements' },
  { path: '/inventory/shipments' },
  { path: '/inventory/stock-counts' },
  { path: '/inventory/transfers' },
  { path: '/finance/receipts' },
  { path: '/finance/receipts/new' },
  { path: '/finance/payments' },
  { path: '/finance/payments/new' },
  { path: '/finance/expenses' },
  { path: '/finance/expenses/new' },
  { path: '/finance/expenses/split' },
  { path: '/finance/expenses/recurring' },
  { path: '/finance/cash-bank' },
  { path: '/finance/intercompany-loan' },
  { path: '/finance/cheques' },
  { path: '/finance/receivables' },
  { path: '/finance/payables' },
  { path: '/finance/reconciliation' },
  { path: '/finance/agent-commission' },
  { path: '/accounting/chart' },
  { path: '/accounting/journal/new' },
  { path: '/accounting/revaluation' },
  { path: '/ledgers/customers' },
  { path: '/ledgers/vendors' },
  { path: '/ledgers/agents' },
  { path: '/customers' },
  { path: '/vendors' },
  { path: '/items' },
  { path: '/agents' },
  { path: '/warehouses' },
  { path: '/ports' },
  { path: '/shipping-lines' },
  { path: '/expense-categories' },
  { path: '/profitability' },
  { path: '/reports' },
  { path: '/reports/trial-balance' },
  { path: '/reports/balance-sheet' },
  { path: '/reports/profit-loss' },
  { path: '/reports/general-ledger' },
  { path: '/reports/journal' },
  { path: '/reports/cash-flow' },
  { path: '/reports/inventory-valuation' },
  { path: '/reports/cogs' },
  { path: '/reports/expenses' },
  { path: '/reports/stock-ageing' },
  { path: '/reports/allocations' },
  { path: '/reports/forex' },
  { path: '/reports/business-overview' },
  { path: '/reports/financial-position' },
  { path: '/reports/reconciliation' },
  { path: '/reports/analytics' },
  { path: '/admin/audit' },
  { path: '/admin/users' },
  { path: '/admin/roles' },
  { path: '/admin/backups' },
  { path: '/settings' },
  { path: '/settings/tax' },
  { path: '/notifications' },
];

/** Console noise that is not a fault and would otherwise drown the signal. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /Lighthouse/i,
  /favicon/i,
];

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  /*
   * Wait for the page to be interactive before touching it. A deployment
   * coming out of a cold start serves the markup well before React has
   * hydrated, and a click that lands in that window does nothing at all —
   * the user tile stays selected, the keypad never opens, and the next step
   * waits for a button that will never exist. This is also what a person
   * meets if they click the instant the page appears.
   */
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });

  /*
   * Click, then give the keypad time to arrive. Only try again if the tile is
   * still on screen, which is the tell that the click was swallowed before
   * hydration finished — once the user is chosen the tile is replaced, and
   * clicking blindly a second time would undo the first.
   */
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

test('every screen opens cleanly, with no failed request and no console error', async ({ page }) => {
  test.setTimeout(20 * 60_000);

  const findings: string[] = [];
  let current = '(sign-in)';

  // Printed the moment it is found, so a run that is cut short still says
  // what it saw rather than losing everything with the summary.
  const note = (line: string) => {
    if (findings.includes(line)) return;
    findings.push(line);
    console.log('  ! ' + line);
  };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
    note(`${current}  CONSOLE  ${text.slice(0, 200)}`);
  });
  page.on('pageerror', (err) => {
    note(`${current}  PAGEERROR  ${err.message.slice(0, 200)}`);
  });
  page.on('response', (res: Response) => {
    const status = res.status();
    if (status < 400) return;
    // A 401/403 on a screen this user may not open is the guard working.
    if (status === 401 || status === 403) return;
    note(`${current}  HTTP ${status}  ${res.url().replace(/https?:\/\/[^/]+/, '')}`);
  });

  await signIn(page);

  for (const screen of SCREENS) {
    current = screen.path;
    const response = await page.goto(screen.path, { waitUntil: 'domcontentloaded' }).catch((e) => {
      note(`${current}  NAVIGATION FAILED  ${String(e).slice(0, 160)}`);
      return null;
    });
    if (!response) continue;

    if (response.status() >= 500) {
      note(`${current}  SERVER ERROR ${response.status()}`);
      continue;
    }

    // Redirected away is fine (permissions); a crash page is not.
    const main = page.getByRole('main');
    const appeared = await main.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    if (!appeared) {
      note(`${current}  no <main> rendered within 30s`);
      continue;
    }

    // A short settle rather than networkidle: this application keeps
    // connections open, so networkidle costs its full timeout on every page.
    await page.waitForTimeout(1_200);
    const text = await main.innerText();

    if (/something went wrong|this page could not|application error|unhandled runtime/i.test(text)) {
      note(`${current}  CRASH PAGE  ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    if (/\bNaN\b/.test(text)) note(`${current}  shows NaN`);
    if (/undefined|\[object Object\]/.test(text)) {
      note(`${current}  leaks a raw value  ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    // Wording the client asked never to see again.
    if (/\brevers(ed|al)\b/i.test(text)) note(`${current}  says "reversed"`);
  }

  console.log(`\nmonitor swept ${SCREENS.length} screens; ${findings.length} finding(s)`);

  expect(findings, findings.join('\n')).toEqual([]);
});
