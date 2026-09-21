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

  { group: 'Sales', label: 'Invoices', href: '/sales' },
  { group: 'Sales', label: 'Customers', href: '/customers' },
  { group: 'Sales', label: 'Payments Received', href: '/finance/receipts' },
  { group: 'Sales', label: 'Credit Notes', href: '/sales/credit-notes' },
  { group: 'Sales', label: 'Receivables', href: '/finance/receivables' },

  { group: 'Purchases', label: 'Purchase Orders', href: '/purchases' },
  { group: 'Purchases', label: 'Suppliers', href: '/vendors' },
  { group: 'Purchases', label: 'Goods Receipts', href: '/goods-receipts' },
  { group: 'Purchases', label: 'Payments Made', href: '/finance/payments' },
  { group: 'Purchases', label: 'Payables', href: '/finance/payables' },

  { group: 'Shipments', label: 'Loading Sheet', href: '/loading' },
  { group: 'Shipments', label: 'Shipments', href: '/shipments' },
  { group: 'Shipments', label: 'Shipment Expenses', href: '/finance/expenses' },

  { group: 'Inventory', label: 'Stock on Hand', href: '/inventory' },
  { group: 'Inventory', label: 'Items', href: '/items' },
  { group: 'Inventory', label: 'Batches', href: '/inventory/batches' },
  { group: 'Inventory', label: 'Warehouses', href: '/warehouses' },
  { group: 'Inventory', label: 'Transfer Orders', href: '/inventory/transfers' },
  { group: 'Inventory', label: 'Stock Movements', href: '/inventory/movements' },
  { group: 'Inventory', label: 'Stock Counts', href: '/inventory/stock-counts' },

  { group: 'Money', label: 'Cash & Bank', href: '/finance/cash-bank' },
  { group: 'Money', label: 'Cheques', href: '/finance/cheques' },
  { group: 'Money', label: 'Agent Commission', href: '/finance/agent-commission' },

  { group: 'Accounting', label: 'General Journal', href: '/reports/journal' },
  { group: 'Accounting', label: 'General Ledger', href: '/reports/general-ledger' },
  { group: 'Accounting', label: 'Chart of Accounts', href: '/accounting/chart' },
  { group: 'Accounting', label: 'Ledgers', href: '/ledgers' },

  { group: 'Master Data', label: 'Agents', href: '/agents' },
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
    // A short deadline of its own: a picker that never appears should fail
    // here in a minute, saying so, rather than eating the whole run's budget
    // and reporting a timeout on a click with no context.
    const choice = page
      .getByRole('button', { name: /FID Trading International SARL/ })
      .or(page.getByRole('link', { name: /FID Trading International SARL/ }))
      .first();
    await expect(choice, 'the company picker should offer FID Trading International SARL').toBeVisible({
      timeout: 30_000,
    });
    await choice.click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

test('audits what every sidebar screen shows without opening a row', async ({ page }) => {
  test.setTimeout(45 * 60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page);

  for (const entry of PAGES) {
    await page.goto(entry.href, { waitUntil: 'domcontentloaded' });
    await page.locator('main').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(250);

    // One pass over the DOM rather than twenty locator round-trips: the
    // per-query cost across thirty-five screens was the whole time budget.
    const seen = await page.evaluate(() => {
      const main = document.querySelector('main') ?? document.body;
      const text = (el: Element | null) => (el?.textContent ?? '').trim().replace(/\s+/g, ' ');

      const columns = [...main.querySelectorAll('thead th')].map((th) => text(th)).filter(Boolean);
      const bodyRows = main.querySelectorAll('tbody tr').length;

      // Anything pressable inside the last cell of a row, or a column called
      // Actions, counts as reachable without opening the row.
      const actionCells = [...main.querySelectorAll('tbody tr > td:last-child')];
      const rowActionLabels = new Set<string>();
      for (const cell of actionCells) {
        for (const el of cell.querySelectorAll('button, a')) {
          const label = text(el) || el.getAttribute('aria-label') || '';
          if (label) rowActionLabels.add(label.toLowerCase());
        }
      }

      // A filter is a <label> or a labelled control. The dropdowns added to
      // the sheets carry an aria-label and no visible <label>, and counting
      // only the latter made every one of those screens report "no filters".
      const labels = [
        ...[...main.querySelectorAll('label')].map((l) => text(l).toLowerCase()),
        ...[...main.querySelectorAll('select[aria-label], input[aria-label]')].map((el) =>
          (el.getAttribute('aria-label') ?? '').toLowerCase(),
        ),
      ];
      const controls = [...main.querySelectorAll('select, input[type="date"]')].length;

      const topButtons = [...main.querySelectorAll('button, a')]
        .map((el) => text(el))
        .filter(Boolean);

      return {
        broke: /this page could|something went wrong/i.test(text(main.querySelector('h1, h2'))),
        columns,
        bodyRows,
        rowActionLabels: [...rowActionLabels],
        hasActionsHeader: columns.some((c) => /action/i.test(c)),
        labels,
        controls,
        hasSearch: Boolean(main.querySelector('input[placeholder*="earch" i]')),
        hasExport: topButtons.some((b) => /excel|csv|export/i.test(b)),
        hasPrint: topButtons.some((b) => /print/i.test(b)),
        createButtons: [...new Set(topButtons.filter((b) => /^(new|add|\+)/i.test(b)))],
      };
    });

    const filters = ['from', 'to', 'status', 'customer', 'supplier', 'currency', 'warehouse', 'account', 'shipment', 'item', 'type']
      .filter((name) => seen.labels.some((l) => l.startsWith(name)));

    findings.push({
      group: entry.group,
      label: entry.label,
      href: entry.href,
      columns: seen.columns,
      rows: seen.bodyRows,
      rowActions: seen.rowActionLabels,
      hasRowActionColumn: seen.hasActionsHeader || seen.rowActionLabels.length > 0,
      filters,
      hasSearch: seen.hasSearch,
      hasExport: seen.hasExport,
      hasPrint: seen.hasPrint,
      createButtons: seen.createButtons,
      note: seen.broke ? 'PAGE ERRORED' : '',
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
