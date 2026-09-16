import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What can a person see without opening anything?
 *
 * The client's complaint is navigational, not arithmetical: to find out what
 * an invoice is worth, who owes it and whether it is paid, they open the
 * invoice. To find out where a container is, they open the purchase order.
 * Every answer costs three clicks and a page load, and the page they land on
 * answers one question rather than twenty.
 *
 * This walks every screen in the sidebar and records what is actually on it:
 * the columns, whether a row offers View / Edit / Delete without being opened
 * first, whether the page has filters, an export and a way to create the thing
 * it lists. It asserts nothing about what *should* be there — it writes the
 * inventory to test-results/visibility-audit.md so the gaps can be read off a
 * single page and argued with.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the visibility audit.');
test.describe.configure({ mode: 'serial' });

/** Every listing screen the sidebar offers, in the order it offers them. */
const PAGES: Array<{ label: string; href: string; group: string }> = [
  { group: 'Overview', label: 'Dashboard', href: '/dashboard' },

  { group: 'Trading', label: 'Purchase Orders', href: '/purchases' },
  { group: 'Trading', label: 'Loading Sheet', href: '/loading' },
  { group: 'Trading', label: 'Purchase Receipts', href: '/goods-receipts' },
  { group: 'Trading', label: 'Sales Invoices', href: '/sales' },
  { group: 'Trading', label: 'Shipments', href: '/shipments' },
  { group: 'Trading', label: 'Credit Notes', href: '/sales/credit-notes' },

  { group: 'Inventory', label: 'Stock on Hand', href: '/inventory' },
  { group: 'Inventory', label: 'Batches', href: '/inventory/batches' },
  { group: 'Inventory', label: 'Warehouse Transfers', href: '/inventory/transfers' },
  { group: 'Inventory', label: 'Stock Movements', href: '/inventory/movements' },
  { group: 'Inventory', label: 'Stock Counts', href: '/inventory/stock-counts' },

  { group: 'Money', label: 'Payments Received', href: '/finance/receipts' },
  { group: 'Money', label: 'Payments Made', href: '/finance/payments' },
  { group: 'Money', label: 'Expenses', href: '/finance/expenses' },
  { group: 'Money', label: 'Cheques', href: '/finance/cheques' },
  { group: 'Money', label: 'Cash & Bank Accounts', href: '/finance/cash-bank' },
  { group: 'Money', label: 'Receivables', href: '/finance/receivables' },
  { group: 'Money', label: 'Payables', href: '/finance/payables' },
  { group: 'Money', label: 'Agent Commission', href: '/finance/agent-commission' },

  { group: 'Accounting', label: 'Journal Entries', href: '/reports/journal' },
  { group: 'Accounting', label: 'General Ledger', href: '/reports/general-ledger' },
  { group: 'Accounting', label: 'Chart of Accounts', href: '/accounting/chart' },
  { group: 'Accounting', label: 'Customer Ledgers', href: '/ledgers/customers' },
  { group: 'Accounting', label: 'Supplier Ledgers', href: '/ledgers/vendors' },
  { group: 'Accounting', label: 'Agent Ledgers', href: '/ledgers/agents' },

  { group: 'Master Data', label: 'Customers', href: '/customers' },
  { group: 'Master Data', label: 'Suppliers', href: '/vendors' },
  { group: 'Master Data', label: 'Agents', href: '/agents' },
  { group: 'Master Data', label: 'Items', href: '/items' },
  { group: 'Master Data', label: 'Warehouses', href: '/warehouses' },
  { group: 'Master Data', label: 'Expense Categories', href: '/expense-categories' },
  { group: 'Master Data', label: 'Shipping Lines', href: '/shipping-lines' },
  { group: 'Master Data', label: 'Ports', href: '/ports' },

  { group: 'Reports', label: 'All Reports', href: '/reports' },
];

type Finding = {
  group: string;
  label: string;
  href: string;
  columns: string[];
  rows: number;
  /** Actions reachable from a row without opening it. */
  rowActions: string[];
  hasRowActionColumn: boolean;
  filters: string[];
  hasSearch: boolean;
  hasExport: boolean;
  hasPrint: boolean;
  createButtons: string[];
  note: string;
};

const findings: Finding[] = [];

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).click();
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading International SARL/ }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

test('audits what every sidebar screen shows without opening a row', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page);

  for (const entry of PAGES) {
    await page.goto(entry.href, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(600);

    const broke = await page
      .getByRole('heading', { name: /this page could|something went wrong/i })
      .count();

    const main = page.getByRole('main');
    const columns = await main.getByRole('columnheader').allInnerTexts();
    const rows = await main.getByRole('row').count();

    // What a person can press on a row, without opening it first.
    const rowActionNames = new Set<string>();
    for (const name of [
      'view', 'open', 'edit', 'delete', 'cancel', 'reverse', 'ledger', 'record payment',
      'pay', 'receive', 'costing', 'print', 'documents', 'transfer', 'actions', 'more',
    ]) {
      const count = await main.getByRole('button', { name: new RegExp(name, 'i') }).count();
      const links = await main.getByRole('link', { name: new RegExp(`^${name}$`, 'i') }).count();
      if (count + links > 0) rowActionNames.add(name);
    }

    // A dedicated actions column, or buttons living loose in the last cell.
    const hasRowActionColumn =
      columns.some((c) => /action/i.test(c)) ||
      (await main.locator('td:last-child button, td:last-child a[role="button"]').count()) > 0;

    const filters: string[] = [];
    for (const label of ['from', 'to', 'status', 'customer', 'supplier', 'currency', 'warehouse', 'account', 'shipment', 'item', 'type']) {
      if ((await main.getByLabel(new RegExp(`^${label}`, 'i')).count()) > 0) filters.push(label);
    }

    const hasSearch = (await main.getByPlaceholder(/search/i).count()) > 0;
    const hasExport =
      (await main.getByRole('link', { name: /excel|csv|export/i }).count()) +
        (await main.getByRole('button', { name: /excel|csv|export/i }).count()) >
      0;
    const hasPrint =
      (await main.getByRole('button', { name: /print/i }).count()) +
        (await main.getByRole('link', { name: /print/i }).count()) >
      0;

    const createButtons = (
      await main.getByRole('link', { name: /^(new|add|\+)/i }).allInnerTexts()
    ).concat(await main.getByRole('button', { name: /^(new|add|\+)/i }).allInnerTexts());

    findings.push({
      group: entry.group,
      label: entry.label,
      href: entry.href,
      columns: columns.map((c) => c.trim()).filter(Boolean),
      rows: Math.max(rows - 1, 0),
      rowActions: [...rowActionNames],
      hasRowActionColumn,
      filters,
      hasSearch,
      hasExport,
      hasPrint,
      createButtons: [...new Set(createButtons.map((c) => c.trim().replace(/\s+/g, ' ')))].filter(Boolean),
      note: broke > 0 ? 'PAGE ERRORED' : '',
    });
  }

  const lines: string[] = [
    '# Visibility audit',
    '',
    'What each sidebar screen shows without opening a row. Generated by',
    '`tests/e2e/visibility-audit.spec.ts` against the running application.',
    '',
    '| Screen | Rows | Columns | Row actions | Filters | Search | Export | Print | Create |',
    '| --- | ---: | --- | --- | --- | :-: | :-: | :-: | --- |',
  ];
  for (const f of findings) {
    lines.push(
      `| ${f.label}${f.note ? ` **${f.note}**` : ''} | ${f.rows} | ${f.columns.length} | ` +
        `${f.hasRowActionColumn ? f.rowActions.join(', ') || 'yes' : '**none**'} | ` +
        `${f.filters.join(', ') || '**none**'} | ${f.hasSearch ? 'y' : '—'} | ` +
        `${f.hasExport ? 'y' : '—'} | ${f.hasPrint ? 'y' : '—'} | ${f.createButtons.join(', ') || '—'} |`,
    );
  }

  lines.push('', '## Columns, screen by screen', '');
  for (const f of findings) {
    lines.push(`### ${f.group} — ${f.label} (\`${f.href}\`)`, '');
    lines.push(f.columns.length ? f.columns.map((c) => `\`${c}\``).join(' · ') : '_no table_');
    lines.push('');
  }

  const dir = path.join(process.cwd(), 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'visibility-audit.md'), lines.join('\n'));
  fs.writeFileSync(path.join(dir, 'visibility-audit.json'), JSON.stringify(findings, null, 2));

  // The audit is the artefact; the only failure is a screen that did not load.
  expect(findings.filter((f) => f.note).map((f) => f.label)).toEqual([]);
});
