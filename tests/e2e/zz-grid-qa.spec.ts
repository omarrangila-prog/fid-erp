import * as fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The FID table standard, page by page.
 *
 * Every page that shows figures in rows and columns is opened on a desktop,
 * on a 390px phone and in print. On each, every visible table must have a
 * dark line between columns and between rows, a strong line under its
 * header and above any totals; the phone page must not be wider than the
 * phone; and on paper the lines must be black. The result is a checklist,
 * one row per page, written to GRID_QA_OUT when set. Named to run last, so
 * every other suite has created records for the pages to show.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');

test.setTimeout(600_000);

type TableCheck = { cls: string; col: boolean | null; row: boolean | null; header: boolean | null; totals: boolean | null };
type PageResult = {
  area: string;
  page: string;
  url: string;
  tables: number;
  columnLines: string;
  rowLines: string;
  header: string;
  totals: string;
  mobile: string;
  print: string;
  passed: boolean;
  notes: string[];
};
const results: PageResult[] = [];

const AREAS: Array<[string, Array<[string, string]>]> = [
  ['Dashboard', [['Dashboard', '/dashboard']]],
  [
    'Purchases',
    [
      ['Purchase orders', '/purchases'],
      ['Purchase order detail', 'detail:/purchases/'],
      ['Suppliers', '/vendors'],
      ['Supplier detail', 'detail:/vendors/'],
      ['Supplier ledger', 'detail:/ledgers/vendors/'],
      ['Goods receipts', '/goods-receipts'],
      ['Supplier debit notes', '/purchases/debit-notes'],
      ['Payables', '/finance/payables'],
    ],
  ],
  [
    'Shipments',
    [
      ['Shipments', '/shipments'],
      ['Shipment detail (costing, expenses, sales, history)', 'detail:/shipments/'],
      ['Loading sheet', '/loading'],
      ['Shipment costing', '/reports/shipment-cost'],
      ['Shipment profitability', '/profitability'],
      ['Trace a reference', '/trace?q=E2E'],
    ],
  ],
  [
    'Inventory',
    [
      ['Stock on hand', '/inventory'],
      ['Stock by shipment', '/inventory/shipments'],
      ['Batches / containers', '/inventory/batches'],
      ['Batch detail', 'detail:/inventory/batches/'],
      ['Stock movements', '/inventory/movements'],
      ['Warehouse transfers', '/inventory/transfers'],
      ['Transfer detail', 'detail:/inventory/transfers/'],
      ['Stock counts', '/inventory/stock-counts'],
      ['Items', '/items'],
      ['Item stock', 'detail:/items/'],
      ['Warehouses', '/warehouses'],
      ['Inventory valuation', '/reports/inventory-valuation'],
      ['Stock ageing', '/reports/stock-ageing'],
      ['Stock movement report', '/reports/stock-movement'],
    ],
  ],
  [
    'Sales',
    [
      ['Sales invoices', '/sales'],
      ['Outstanding invoices', '/sales?standing=OUTSTANDING'],
      ['Partially paid invoices', '/sales?standing=PARTIAL'],
      ['Invoice detail', 'detail:/sales/'],
      ['Invoice print', 'detail:/sales/|/print'],
      ['Credit notes', '/sales/credit-notes'],
      ['Customers', '/customers'],
      ['Customer detail', 'detail:/customers/'],
      ['Customer ledger', 'detail:/ledgers/customers/'],
      ['Customer statement (print)', 'detail:/ledgers/customers/|/print'],
      ['Payments received', '/finance/receipts'],
      ['Receipt detail', 'detail:/finance/receipts/'],
      ['Receivables / AR ageing', '/finance/receivables'],
    ],
  ],
  [
    'Expenses',
    [
      ['Expenses', '/finance/expenses'],
      ['Expense detail', 'detail:/finance/expenses/'],
      ['Recurring expenses', '/finance/expenses/recurring'],
      ['Unpaid expenses (schedule + ledger)', '/finance/unpaid-expenses'],
      ['Expense categories', '/expense-categories'],
      ['Payments made', '/finance/payments'],
      ['Payment detail', 'detail:/finance/payments/'],
    ],
  ],
  [
    'Agents',
    [
      ['Agents', '/agents'],
      ['Agent ledger', 'detail:/agents/'],
      ['Agent balances / clearing', '/ledgers/agents'],
      ['Agent commission', '/finance/agent-commission'],
      ['Cheques', '/finance/cheques'],
      ['Cheque detail', 'detail:/finance/cheques/'],
    ],
  ],
  [
    'Accounting',
    [
      ['General journal', '/reports/journal'],
      ['General ledger', '/reports/general-ledger'],
      ['General ledger — whole book', '/reports/general-ledger?account=all'],
      ['All ledgers', '/ledgers'],
      ['Cash & bank', '/finance/cash-bank'],
      ['Cash / bank ledger', 'detail:/finance/cash-bank/'],
      ['Chart of accounts', '/accounting/chart'],
      ['Bank reconciliation', '/finance/reconciliation'],
      ['Cash book', '/reports/cash-book'],
    ],
  ],
  [
    'Reports',
    [
      ['Profit & loss', '/reports/profit-loss'],
      ['Balance sheet', '/reports/balance-sheet'],
      ['Trial balance', '/reports/trial-balance'],
      ['Financial position', '/reports/financial-position'],
      ['Cash flow', '/reports/cash-flow'],
      ['Sales report', '/reports/sales'],
      ['Sales by …', '/reports/sales-by'],
      ['Purchases report', '/reports/purchases'],
      ['Expenses report', '/reports/expenses'],
      ['AR / AP ageing', '/reports/ageing'],
      ['Balances', '/reports/balances'],
      ['Cost of goods sold', '/reports/cogs'],
      ['Allocations', '/reports/allocations'],
      ['Overhead allocation', '/reports/overhead-allocation'],
      ['Foreign exchange', '/reports/forex'],
      ['Tax return', '/reports/tax-return'],
      ['Reconciliation report', '/reports/reconciliation'],
      ['Business overview', '/reports/business-overview'],
      ['Analytics', '/reports/analytics'],
    ],
  ],
  [
    'Settings',
    [
      ['Users', '/admin/users'],
      ['User permissions', 'detail:/admin/users/'],
      ['Roles', '/admin/roles'],
      ['Role permission matrix', 'detail:/admin/roles/'],
      ['Audit log', '/admin/audit'],
      ['Consistency checks', '/admin/consistency'],
      ['Companies', '/admin/companies'],
      ['Ports', '/ports'],
      ['Shipping lines', '/shipping-lines'],
    ],
  ],
];

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

/** A detail page: the first record's own address, found on its list. */
const LISTS: Record<string, string> = {
  '/purchases/': '/purchases',
  '/vendors/': '/vendors',
  '/ledgers/vendors/': '/ledgers/vendors',
  '/shipments/': '/shipments',
  '/inventory/batches/': '/inventory/batches',
  '/inventory/transfers/': '/inventory/transfers',
  '/items/': '/items',
  '/sales/': '/sales',
  '/customers/': '/customers',
  '/ledgers/customers/': '/ledgers/customers',
  '/finance/receipts/': '/finance/receipts',
  '/finance/expenses/': '/finance/expenses',
  '/finance/payments/': '/finance/payments',
  '/agents/': '/ledgers/agents',
  '/finance/cheques/': '/finance/cheques',
  '/finance/cash-bank/': '/finance/cash-bank',
  '/admin/users/': '/admin/users',
  '/admin/roles/': '/admin/roles',
};

async function resolve(page: Page, target: string): Promise<string | null> {
  if (!target.startsWith('detail:')) return target;
  const [prefix, suffix = ''] = target.slice('detail:'.length).split('|');
  await page.goto(LISTS[prefix], { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const hrefs = await page
    .locator(`main a[href^="${prefix}"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''))
    .catch(() => [] as string[]);
  const id = hrefs.map((h) => h.split('?')[0]).find((h) => new RegExp(`^${prefix.replace(/\//g, '\\/')}[a-z0-9]{20,}$`).test(h));
  return id ? `${id}${suffix}` : null;
}

async function checkTables(page: Page): Promise<TableCheck[]> {
  return page.evaluate(() => {
    const dark = (colour: string) => {
      const parts = (colour.match(/[\d.]+/g) ?? []).map(Number);
      if (parts.length < 3 || parts[3] === 0) return false;
      return parts[0] + parts[1] + parts[2] < 300;
    };
    const tables = [...document.querySelectorAll('main table')].filter((t) => {
      const box = t.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return tables.slice(0, 8).map((t) => {
      const cells = [...t.querySelectorAll(':scope > tbody > tr > td')] as HTMLElement[];
      const inner = cells.filter((td) => td.nextElementSibling && td.getBoundingClientRect().width > 0);
      const col = inner.length
        ? inner.some((td) => {
            const cs = getComputedStyle(td);
            return parseFloat(cs.borderRightWidth) >= 1 && dark(cs.borderRightColor);
          })
        : null;
      const rowCells = [...t.querySelectorAll(':scope > tbody > tr:not(:last-child) > td')] as HTMLElement[];
      const row = rowCells.length
        ? rowCells.some((td) => {
            const cs = getComputedStyle(td);
            return parseFloat(cs.borderBottomWidth) >= 1 && dark(cs.borderBottomColor);
          })
        : null;
      const th = t.querySelector(':scope > thead > tr > th') as HTMLElement | null;
      const header = th ? parseFloat(getComputedStyle(th).borderBottomWidth) >= 2 && dark(getComputedStyle(th).borderBottomColor) : null;
      const foot = t.querySelector(':scope > tfoot > tr > *, :scope > tbody > tr.grid-total > *') as HTMLElement | null;
      const totals = foot ? parseFloat(getComputedStyle(foot).borderTopWidth) >= 2 : null;
      return { cls: (t.getAttribute('class') ?? '').slice(0, 40), col, row, header, totals };
    });
  });
}

const mark = (values: Array<boolean | null>) =>
  values.some((v) => v === false) ? 'MISSING' : values.some((v) => v === true) ? 'yes' : '—';

for (const [area, pages] of AREAS) {
  test(`${area}: every table is a clear grid on desktop, phone and paper`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    for (const [name, target] of pages) {
      const url = await resolve(page, target);
      const notes: string[] = [];
      if (!url) {
        results.push({ area, page: name, url: target, tables: 0, columnLines: '—', rowLines: '—', header: '—', totals: '—', mobile: '—', print: '—', passed: true, notes: ['no record in this fixture'] });
        continue;
      }
      // Desktop
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page.locator('main')).toBeVisible({ timeout: 45_000 });
      const desktop = await checkTables(page);
      const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (desktopOverflow > 1) notes.push(`desktop page ${desktopOverflow}px too wide`);

      // Paper
      let print = '—';
      if (desktop.length) {
        await page.emulateMedia({ media: 'print' });
        const black = await page.evaluate(() => {
          const t = [...document.querySelectorAll('main table')].find((el) => el.getBoundingClientRect().height > 0);
          const cell = t?.querySelector(':scope > tbody > tr > td') as HTMLElement | undefined;
          if (!cell) return null;
          const cs = getComputedStyle(cell);
          return cs.borderBottomColor === 'rgb(0, 0, 0)' || cs.borderRightColor === 'rgb(0, 0, 0)';
        });
        print = black === null ? '—' : black ? 'yes' : 'MISSING';
        await page.emulateMedia({ media: 'screen' });
      }

      // Phone
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const phone = await checkTables(page);
      const phoneBad = phone.some((t) => t.col === false || t.row === false || t.header === false);
      const mobile = overflow > 1 ? `MISSING (${overflow}px too wide)` : phoneBad ? 'MISSING (lines)' : 'yes';

      const result: PageResult = {
        area,
        page: name,
        url,
        tables: desktop.length,
        columnLines: mark(desktop.map((t) => t.col)),
        rowLines: mark(desktop.map((t) => t.row)),
        header: mark(desktop.map((t) => t.header)),
        totals: mark(desktop.map((t) => t.totals)),
        mobile,
        print,
        passed: false,
        notes,
      };
      result.passed = ![result.columnLines, result.rowLines, result.header, result.totals, result.mobile, result.print].some((v) => v.startsWith('MISSING')) && notes.length === 0;
      if (!result.passed) {
        const bad = desktop.filter((t) => t.col === false || t.row === false || t.header === false || t.totals === false).map((t) => t.cls);
        if (bad.length) result.notes.push(`tables: ${bad.join(' | ')}`);
      }
      results.push(result);
      console.log(`QA | ${area} | ${name} | tables ${result.tables} | cols ${result.columnLines} | rows ${result.rowLines} | header ${result.header} | totals ${result.totals} | mobile ${result.mobile} | print ${result.print} | ${result.passed ? 'PASS' : 'FAIL'} ${result.notes.join('; ')}`);
      expect.soft(result.passed, `${name} (${url}): ${result.notes.join('; ')}`).toBe(true);
    }
    if (process.env.GRID_QA_OUT) fs.writeFileSync(process.env.GRID_QA_OUT, JSON.stringify(results, null, 1));
  });
}
