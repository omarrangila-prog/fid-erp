import fs from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Share on WhatsApp.
 *
 * On the reports the brief names — customer, supplier and agent ledgers, cash
 * and bank, unpaid expenses, shipment profitability, stock, profit and loss,
 * outstanding invoices — the WhatsApp button is there, the dialog names the
 * right report, the filters on screen are the filters shared, hidden columns
 * stay hidden, the secure link opens exactly that report to somebody who is
 * not signed in (and nothing else), a phone gets the PDF through its share
 * sheet, every share is logged, and only the developer can read the log.
 *
 * WhatsApp itself is not opened: window.open and the share sheet are
 * replaced with recorders, so the test sees exactly what would have been
 * handed to WhatsApp. Named to run near the end, after the other suites have
 * put transactions on the ledgers.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
const DEV_PIN = process.env.E2E_DEVELOPER_PIN ?? '';
const STAFF_PIN = process.env.DUBAI_STAFF_PIN ?? '';
test.skip(!ADMIN_PIN || !DEV_PIN, 'Set ADMIN_PIN (and let playwright.config.ts draw E2E_DEVELOPER_PIN) to run this suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

async function pinIn(page: Page, pin: string) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible({ timeout: 45_000 });
  for (const digit of pin) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company|unauthorized)/, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (page.url().includes('select-company')) {
    await chooseCompany(page, /FID Trading International SARL/);
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

/** window.open and the share sheet, recorded instead of performed. */
async function recordShares(page: Page, files: boolean) {
  await page.addInitScript((canFiles: boolean) => {
    const w = window as unknown as { __opened: string[]; __shared: unknown[]; open: unknown };
    w.__opened = [];
    w.__shared = [];
    w.open = (url?: string) => {
      if (url) w.__opened.push(url);
      return {
        opener: null,
        close() {},
        location: {
          set href(value: string) {
            w.__opened.push(value);
          },
          get href() {
            return '';
          },
        },
      };
    };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canFiles ? () => true : undefined });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: canFiles
        ? async (data: { title?: string; text?: string; files?: File[] }) => {
            const first = data.files?.[0];
            const head = first ? new TextDecoder().decode(new Uint8Array(await first.slice(0, 5).arrayBuffer())) : '';
            w.__shared.push({ title: data.title, text: data.text, name: first?.name, type: first?.type, size: first?.size, head });
          }
        : undefined,
    });
  }, files);
}

/** Refused: the in-app "does not exist" page, and none of the log. */
async function expectNotFound(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'That record does not exist' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('share-activity')).toHaveCount(0);
}

/** Opens a menu group so its links are on the page. */
async function openMenuGroup(page: Page, group: string) {
  const heading = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${group}\\b`) });
  if ((await heading.count()) && (await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
}

async function openDialog(page: Page, scope = page.getByRole('main')) {
  await scope.getByTestId('share-whatsapp').first().click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('share-summary')).toContainText(/row/, { timeout: 30_000 });
  return dialog;
}

/** Shares as a secure link and returns it, with what would have gone to WhatsApp. */
async function shareLink(page: Page, dialog: ReturnType<Page['getByTestId']>, expiry = '1') {
  await dialog.getByTestId('share-format-link').check();
  await dialog.getByTestId('share-expiry').selectOption(expiry);
  await dialog.getByTestId('share-submit').click();
  await expect(dialog.getByTestId('share-link-ready')).toBeVisible({ timeout: 45_000 });
  const url = (await dialog.getByTestId('share-link-url').innerText()).trim();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{40,}$/);
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  const whatsapp = opened.find((u) => u.startsWith('https://wa.me/'));
  expect(whatsapp, 'WhatsApp should have been opened').toBeTruthy();
  expect(decodeURIComponent(whatsapp!)).toContain(url);
  return { url, whatsapp: decodeURIComponent(whatsapp!) };
}

/** Opens a link as somebody who is not signed in. */
async function asRecipient(browser: Browser, url: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, close: () => context.close() };
}

const dataRows = (page: Page) => page.locator('[data-testid="shared-table"] tr[data-kind="row"]');

async function firstWithEntries(page: Page, list: string, link: string): Promise<string> {
  await page.goto(list, { waitUntil: 'domcontentloaded' });
  const links = page.locator(link);
  await expect(links.first()).toBeAttached({ timeout: 45_000 });
  const hrefs = [...new Set(await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? '')))].filter(Boolean);
  for (const href of hrefs) {
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ledger-report')).toBeVisible({ timeout: 45_000 });
    if ((await page.getByTestId('ledger-row').count()) > 0) return href;
  }
  return hrefs[0];
}

const results: Array<{ page: string; url: string; button: boolean; rows: number; link: boolean; filters: boolean; audit?: boolean }> = [];
const links: Record<string, string> = {};

test.describe('Share on WhatsApp', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await recordShares(page, false);
    await pinIn(page, ADMIN_PIN);
  });

  test.afterAll(async () => {
    await page?.close();
    if (process.env.SHARE_QA_OUT) fs.writeFileSync(process.env.SHARE_QA_OUT, JSON.stringify(results, null, 2));
  });

  for (const ledger of [
    { name: 'Customer Ledger', list: '/ledgers/customers', link: 'main a[href^="/ledgers/customers/"]:not([href$="/print"])' },
    { name: 'Supplier Ledger', list: '/ledgers/vendors', link: 'main a[href^="/ledgers/vendors/"]:not([href$="/print"])' },
    { name: 'Agent Ledger', list: '/ledgers/agents', link: 'main a[href^="/agents/"]' },
    { name: 'Cash & Bank Ledger', list: '/finance/cash-bank', link: 'main a[href^="/finance/cash-bank/"]:has-text("Cash")' },
    { name: 'Cash & Bank Ledger', list: '/finance/cash-bank', link: 'main a[href^="/finance/cash-bank/"]:has-text("Bank")' },
  ]) {
    test(`${ledger.name} (${ledger.link.includes('Bank') ? 'bank' : ledger.link.includes('Cash') ? 'cash' : 'party'}): filters kept, hidden columns hidden, totals as on screen`, async ({ browser }) => {
      const href = await firstWithEntries(page, ledger.list, ledger.link);
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      const report = page.getByTestId('ledger-report');
      await expect(report).toBeVisible({ timeout: 45_000 });
      const rowsOnScreen = await page.getByTestId('ledger-row').count();
      test.skip(rowsOnScreen === 0, 'No entries on this ledger in the fixture.');

      // A search from the first row's memo: the share must carry it and only the rows it leaves.
      const memo = (await page.getByTestId('ledger-row').first().locator('td[data-col="memo"]').innerText()).trim();
      const word = memo.split(/[\s—,.:()/]+/).find((w) => w.length >= 4) ?? memo.slice(0, 4);
      await page.getByLabel('Search the ledger').fill(word);
      const pagination = await page.getByTestId('ledger-pagination').innerText();
      const expected = Number(/of (\d+)/.exec(pagination)?.[1] ?? '0');
      expect(expected).toBeGreaterThan(0);
      // The columns this reader has on screen, in order.
      const onScreen = await page.locator('[data-testid="ledger-table"] thead th[data-col]').evaluateAll((ths) =>
        ths.map((th) => ({ key: th.getAttribute('data-col') ?? '', label: (th.textContent ?? '').trim() })),
      );
      // Opening, debit, credit, closing — as the summary above the ledger shows them.
      const [, debit, credit, closing] = (await page.getByTestId('ledger-summary').locator('dd').allInnerTexts()).map((t) => t.trim());

      const dialog = await openDialog(page, report);
      await expect(dialog.getByTestId('share-report')).toContainText(ledger.name.replace(' & ', ' & '));
      await expect(dialog.getByTestId('share-filters')).toContainText(`Search: ${word}`);
      await expect(dialog.getByTestId('share-scope-filtered')).toBeChecked();
      // The columns on screen are ticked; every other one is offered but not ticked.
      const offered = await dialog.locator('[data-testid^="share-column-"]').evaluateAll((els) =>
        els.map((el) => ({ key: (el.getAttribute('data-testid') ?? '').replace('share-column-', ''), checked: (el as HTMLInputElement).checked })),
      );
      expect(offered.filter((c) => c.checked).map((c) => c.key)).toEqual(onScreen.map((c) => c.key));
      expect(offered.length).toBeGreaterThan(onScreen.length);
      const { url, whatsapp } = await shareLink(page, dialog);
      expect(whatsapp).toContain('View report:');
      links[`${ledger.name} ${href}`] = url;

      const recipient = await asRecipient(browser, url);
      try {
        const r = recipient.page;
        await expect(r.getByTestId('shared-title')).toHaveText(ledger.name);
        await expect(r.getByTestId('shared-filters')).toContainText(`Search: ${word}`);
        await expect(dataRows(r)).toHaveCount(expected);
        const headers = (await r.locator('[data-testid="shared-table"] thead th').allInnerTexts()).map((t) => t.trim());
        expect(headers).toEqual(onScreen.map((c) => c.label));
        expect(headers).toEqual(expect.arrayContaining(['Date', 'Memo', 'Debit', 'Credit', 'Balance']));
        // The same figures the screen showed.
        const facts = (await r.getByTestId('shared-facts').innerText()).replace(/\s+/g, ' ');
        for (const figure of [debit, credit, closing]) expect(facts).toContain(figure);
        // Read-only, and nothing else of the ERP.
        await expect(r.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
        await expect(r.locator('a[href^="/"]')).toHaveCount(0);
      } finally {
        await recipient.close();
      }
      results.push({ page: ledger.name, url: href, button: true, rows: expected, link: true, filters: true });
    });
  }

  test('a phone hands the PDF to its share sheet, and Download PDF gives the same file', async ({ browser }) => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await recordShares(phone, true);
    try {
      await pinIn(phone, ADMIN_PIN);
      const href = await firstWithEntries(phone, '/ledgers/agents', 'main a[href^="/agents/"]');
      await phone.goto(href, { waitUntil: 'domcontentloaded' });
      const button = phone.getByTestId('ledger-report').getByTestId('share-whatsapp');
      await expect(button).toBeVisible({ timeout: 45_000 });
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(32);

      const dialog = await openDialog(phone, phone.getByTestId('ledger-report'));
      await dialog.getByTestId('share-format-pdf').check();
      await expect(dialog.getByTestId('share-submit')).toBeEnabled({ timeout: 30_000 });
      await dialog.getByTestId('share-submit').click();
      await expect
        .poll(async () => (await phone.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).length, { timeout: 30_000 })
        .toBe(1);
      const [shared] = (await phone.evaluate(() => (window as unknown as { __shared: Array<Record<string, unknown>> }).__shared)) as Array<{
        name: string;
        type: string;
        size: number;
        head: string;
        text: string;
      }>;
      expect(shared.type).toBe('application/pdf');
      expect(shared.name).toMatch(/Agent-Ledger.*\.pdf$/);
      expect(shared.head).toBe('%PDF-');
      expect(shared.size).toBeGreaterThan(2_000);
      expect(shared.text).toContain('Agent Ledger');

      const again = await openDialog(phone, phone.getByTestId('ledger-report'));
      const [download] = await Promise.all([phone.waitForEvent('download'), again.getByTestId('share-download-pdf').click()]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);
      const file = await download.path();
      expect(fs.readFileSync(file!).subarray(0, 5).toString()).toBe('%PDF-');
      results.push({ page: 'Agent Ledger (phone, PDF)', url: href, button: true, rows: 0, link: false, filters: true });
    } finally {
      await phone.close();
    }
  });

  test('ticked rows only: two invoices ticked, two invoices shared', async ({ browser }) => {
    await page.goto('/sales', { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    await expect(main.getByTestId('share-whatsapp')).toBeVisible({ timeout: 45_000 });
    const dialog = await openDialog(page);
    await dialog.getByTestId('share-choose-rows').click();
    const boxes = main.locator('table tbody [data-testid="table-select-row"]');
    await expect(boxes.first()).toBeVisible({ timeout: 20_000 });
    test.skip((await boxes.count()) < 2, 'Needs two invoices.');
    const invoiceNumbers: string[] = [];
    for (const i of [0, 1]) {
      await boxes.nth(i).check();
      invoiceNumbers.push((await boxes.nth(i).locator('xpath=ancestor::tr').locator('td').nth(1).innerText()).trim().split('\n')[0]);
    }
    await expect(page.getByTestId('table-selection-bar')).toContainText('2 rows selected');
    await page.getByTestId('table-share-selected').click();
    const shareDialog = page.getByTestId('share-dialog');
    await expect(shareDialog.getByTestId('share-scope-selected')).toBeChecked();
    await expect(shareDialog.getByTestId('share-summary')).toContainText('2 rows');
    const { url } = await shareLink(page, shareDialog);
    const recipient = await asRecipient(browser, url);
    try {
      await expect(dataRows(recipient.page)).toHaveCount(2);
      for (const n of invoiceNumbers) await expect(recipient.page.getByTestId('shared-table')).toContainText(n);
    } finally {
      await recipient.close();
    }
    results.push({ page: 'Sales Invoices (2 selected)', url: '/sales', button: true, rows: 2, link: true, filters: true });
  });

  for (const report of [
    { name: 'Outstanding Invoices', url: '/sales?standing=OUTSTANDING', title: 'Outstanding Invoices', filter: 'Unpaid and partially paid' },
    { name: 'Unpaid Expenses', url: '/finance/unpaid-expenses', title: 'Unpaid Expenses' },
    { name: 'Stock on Hand', url: '/inventory', title: 'Stock on Hand' },
    { name: 'Shipment Profitability', url: '/profitability', title: 'Shipment Profitability' },
    { name: 'Profit & Loss', url: '/reports/profit-loss', title: 'Profit & Loss', period: true },
  ]) {
    test(`${report.name}: the report shared is the report on screen`, async ({ browser }) => {
      await page.goto(report.url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const main = page.getByRole('main');
      await expect(main.getByTestId('share-whatsapp').first()).toBeVisible({ timeout: 45_000 });
      const dialog = await openDialog(page);
      await expect(dialog.getByTestId('share-report')).toContainText(report.title);
      if (report.filter) await expect(dialog.getByTestId('share-filters')).toContainText(report.filter);
      if (report.period) await expect(dialog.getByTestId('share-period')).toContainText(/\d{4}/);
      const summary = await dialog.getByTestId('share-summary').innerText();
      const rows = Number(/^([\d,]+) row/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
      if (rows === 0 && (await dialog.getByText('There is nothing in this selection to share.').count()) > 0) {
        results.push({ page: report.name, url: report.url, button: true, rows: 0, link: false, filters: Boolean(report.filter) });
        test.skip(true, 'Nothing on this report in the fixture.');
      }
      const { url } = await shareLink(page, dialog);
      links[report.name] = url;
      const recipient = await asRecipient(browser, url);
      try {
        await expect(recipient.page.getByTestId('shared-title')).toHaveText(report.title);
        if (report.filter) await expect(recipient.page.getByTestId('shared-filters')).toContainText(report.filter);
        await expect(dataRows(recipient.page)).toHaveCount(rows);
        await expect(recipient.page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      } finally {
        await recipient.close();
      }
      results.push({ page: report.name, url: report.url, button: true, rows, link: true, filters: Boolean(report.filter) });
    });
  }

  test('a link-preview robot is told nothing, and a revoked link stops opening', async ({ browser, request }) => {
    const url = links['Profit & Loss'] ?? Object.values(links)[0];
    test.skip(!url, 'No link was made.');
    const preview = await request.get(url, { headers: { 'user-agent': 'WhatsApp/2.24.1.1 A' } });
    const html = await preview.text();
    expect(html).not.toContain('data-testid="shared-table"');
    expect(html).toContain('Open this link to view the report');

    await page.goto('/admin/shared-links', { waitUntil: 'domcontentloaded' });
    const rows = page.getByTestId('shared-link-row');
    await expect(rows.first()).toBeVisible({ timeout: 45_000 });
    page.once('dialog', (d) => void d.accept());
    const target = rows.filter({ hasText: 'Profit & Loss' }).first();
    const revoke = (await target.count()) ? target : rows.first();
    const token = url.split('/s/')[1];
    await revoke.getByTestId('revoke-share-link').click();
    await expect(page.getByText(/Link revoked/).first()).toBeVisible({ timeout: 30_000 });

    // The one revoked answers "withdrawn"; find which by opening each link we made.
    const recipient = await browser.newContext();
    try {
      const r = await recipient.newPage();
      let withdrawn = 0;
      for (const link of Object.values(links)) {
        await r.goto(link, { waitUntil: 'domcontentloaded' });
        if ((await r.getByText('This link was withdrawn').count()) > 0) withdrawn += 1;
      }
      expect(withdrawn).toBe(1);
      expect(token.length).toBeGreaterThan(40);
    } finally {
      await recipient.close();
    }
  });

  test('the share log is the developer’s: the owner and staff get "not found"', async ({ browser }) => {
    await expectNotFound(page, '/admin/share-activity');
    await openMenuGroup(page, 'Administration');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shared Links', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Share Activity' })).toHaveCount(0);
    // The ordinary audit log does not carry the shares either.
    await page.goto('/admin/audit', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main')).not.toContainText(/SHARE_INITIATED|Share Initiated|Link Generated/i, { timeout: 30_000 });

    if (STAFF_PIN) {
      const staff = await browser.newPage();
      try {
        await pinIn(staff, STAFF_PIN);
        await expectNotFound(staff, '/admin/share-activity');
      } finally {
        await staff.close();
      }
    }

    const dev = await browser.newPage();
    try {
      await pinIn(dev, DEV_PIN);
      await dev.goto('/admin/share-activity', { waitUntil: 'domcontentloaded' });
      await expect(dev.getByTestId('share-activity')).toBeVisible({ timeout: 45_000 });
      await openMenuGroup(dev, 'Administration');
      await expect(dev.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Share Activity' })).toBeVisible();
      const table = dev.getByTestId('share-activity-table');
      await expect(table).toBeVisible();
      await expect(table).toContainText('Agent Ledger');
      await expect(table).toContainText('Outstanding Invoices');
      await expect(table).toContainText('WhatsApp opened');
      await expect(table).toContainText('Link generated');
      await expect(table).toContainText('Share sheet opened');
      await expect(table).toContainText('PDF downloaded');
      await expect(table).not.toContainText(/\bSent\b/);
      // Somebody opened the links: the server counted it. The preview robot did not.
      const views = await dev.getByTestId('share-activity-views').allInnerTexts();
      expect(views.some((v) => Number(v) >= 1)).toBe(true);
      await expect(dev.getByTestId('share-summary-cards')).toContainText('Link shares');

      // Search narrows it to one party's shares.
      await dev.getByLabel('Search the share log').fill('Outstanding');
      await dev.getByRole('button', { name: 'Apply' }).click();
      await dev.waitForURL(/q=Outstanding/);
      const rows = dev.getByTestId('share-activity-row');
      await expect(rows.first()).toBeVisible();
      for (const text of await rows.allInnerTexts()) expect(text).toMatch(/Outstanding/);
      for (const r of results) r.audit = true;
    } finally {
      await dev.close();
    }
  });
});

/**
 * The page-by-page audit: every report and list page the menu offers, and the
 * detail pages behind them. Each one must offer Share, open the dialog on the
 * right report, and have something to share or say that there is nothing.
 * Written to SHARE_QA_OUT as the matrix the brief asks for.
 */
const MATRIX: Array<{ page: string; url?: string; list?: string; pattern?: RegExp; kind: 'ledger' | 'list' | 'report' | 'detail' }> = [
  { page: 'Customer Ledger', list: '/ledgers/customers', pattern: /^\/ledgers\/customers\/[a-z0-9]{20,}$/, kind: 'ledger' },
  { page: 'Customer Statement (print)', list: '/ledgers/customers', pattern: /^\/ledgers\/customers\/[a-z0-9]{20,}$/, kind: 'detail' },
  { page: 'Supplier Ledger', list: '/ledgers/vendors', pattern: /^\/ledgers\/vendors\/[a-z0-9]{20,}$/, kind: 'ledger' },
  { page: 'Supplier Statement (print)', list: '/ledgers/vendors', pattern: /^\/ledgers\/vendors\/[a-z0-9]{20,}$/, kind: 'detail' },
  { page: 'Agent Ledger', list: '/ledgers/agents', pattern: /^\/agents\/[a-z0-9]{20,}$/, kind: 'ledger' },
  { page: 'Cash / Bank Ledger', list: '/finance/cash-bank', pattern: /^\/finance\/cash-bank\/[a-z0-9]{20,}$/, kind: 'ledger' },
  { page: 'General Ledger', url: '/reports/general-ledger', kind: 'report' },
  { page: 'Unpaid Expenses', url: '/finance/unpaid-expenses', kind: 'list' },
  { page: 'Agent Balances', url: '/ledgers/agents', kind: 'report' },
  { page: 'Agent Commission', url: '/finance/agent-commission', kind: 'list' },
  { page: 'Profit & Loss', url: '/reports/profit-loss', kind: 'report' },
  { page: 'Balance Sheet', url: '/reports/balance-sheet', kind: 'report' },
  { page: 'Trial Balance', url: '/reports/trial-balance', kind: 'report' },
  { page: 'Cash Flow', url: '/reports/cash-flow', kind: 'report' },
  { page: 'Cash Book & Bank Book', url: '/reports/cash-book', kind: 'report' },
  { page: 'General Journal', url: '/reports/journal', kind: 'list' },
  { page: 'Chart of Accounts', url: '/accounting/chart', kind: 'report' },
  { page: 'Account Balances', url: '/reports/balances', kind: 'report' },
  { page: 'Business Overview', url: '/reports/business-overview', kind: 'report' },
  { page: 'Financial Position', url: '/reports/financial-position', kind: 'report' },
  { page: 'Exchange Differences', url: '/reports/forex', kind: 'report' },
  { page: 'Cost of Goods Sold', url: '/reports/cogs', kind: 'report' },
  { page: 'Tax Return', url: '/reports/tax-return', kind: 'report' },
  { page: 'Reconciliation', url: '/reports/reconciliation', kind: 'report' },
  { page: 'Analytics', url: '/reports/analytics', kind: 'report' },
  { page: 'Shipment Profitability', url: '/profitability', kind: 'report' },
  { page: 'Shipment Costing', url: '/reports/shipment-cost', kind: 'report' },
  { page: 'Shipment Report (detail)', list: '/shipments', pattern: /^\/shipments\/[a-z0-9]{20,}$/, kind: 'detail' },
  { page: 'Shipments', url: '/shipments', kind: 'list' },
  { page: 'Loading Sheet', url: '/loading', kind: 'list' },
  { page: 'Container Allocation', url: '/reports/allocations', kind: 'report' },
  { page: 'Expenses', url: '/finance/expenses', kind: 'list' },
  { page: 'Shipment Expenses', url: '/finance/expenses?kind=SHIPMENT', kind: 'list' },
  { page: 'Expense Report', url: '/reports/expenses', kind: 'report' },
  { page: 'Sales Invoices', url: '/sales', kind: 'list' },
  { page: 'Outstanding Invoices', url: '/sales?standing=OUTSTANDING', kind: 'list' },
  { page: 'Sales Invoice (detail)', list: '/sales', pattern: /^\/sales\/[a-z0-9]{20,}$/, kind: 'detail' },
  { page: 'Sales Invoice (print)', list: '/sales', pattern: /^\/sales\/[a-z0-9]{20,}$/, kind: 'detail' },
  { page: 'Sales Report', url: '/reports/sales', kind: 'report' },
  { page: 'Sales Summary', url: '/reports/sales-by', kind: 'report' },
  { page: 'Customers', url: '/customers', kind: 'list' },
  { page: 'Payments Received', url: '/finance/receipts', kind: 'list' },
  { page: 'Receivables', url: '/finance/receivables', kind: 'list' },
  { page: 'Ageing', url: '/reports/ageing', kind: 'report' },
  { page: 'Credit Notes', url: '/sales/credit-notes', kind: 'list' },
  { page: 'Purchase Orders', url: '/purchases', kind: 'list' },
  { page: 'Purchase Report', url: '/reports/purchases', kind: 'report' },
  { page: 'Suppliers', url: '/vendors', kind: 'list' },
  { page: 'Payments Made', url: '/finance/payments', kind: 'list' },
  { page: 'Payables', url: '/finance/payables', kind: 'list' },
  { page: 'Goods Receipts', url: '/goods-receipts', kind: 'list' },
  { page: 'Stock on Hand', url: '/inventory', kind: 'list' },
  { page: 'Batches / Containers', url: '/inventory/batches', kind: 'list' },
  { page: 'Stock Movements', url: '/inventory/movements', kind: 'list' },
  { page: 'Stock Movement Report', url: '/reports/stock-movement', kind: 'report' },
  { page: 'Stock Ageing', url: '/reports/stock-ageing', kind: 'report' },
  { page: 'Inventory Valuation', url: '/reports/inventory-valuation', kind: 'report' },
  { page: 'Warehouse Transfers', url: '/inventory/transfers', kind: 'list' },
  { page: 'Items', url: '/items', kind: 'list' },
  { page: 'Cash & Bank Accounts', url: '/finance/cash-bank', kind: 'report' },
  { page: 'Cheque Register', url: '/finance/cheques', kind: 'list' },
];

test('page-by-page: every report and list offers Share on WhatsApp', async ({ browser }) => {
  test.setTimeout(900_000);
  const page = await browser.newPage();
  await recordShares(page, false);
  await pinIn(page, ADMIN_PIN);
  const matrix: Array<Record<string, string | number | boolean>> = [];
  const missing: string[] = [];
  try {
    for (const entry of MATRIX) {
      let url = entry.url;
      if (!url && entry.list && entry.pattern) {
        await page.goto(entry.list, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        const hrefs = await page.locator('main a[href]').evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
        const found = hrefs.find((h) => entry.pattern!.test(h.split('?')[0]));
        url = found ? (entry.page.includes('(print)') && !found.endsWith('/print') ? `${found}/print` : found) : undefined;
      }
      if (!url) {
        matrix.push({ page: entry.page, url: '—', button: false, dialog: false, rows: 0, pdf: false, link: false, filters: false, selectedRows: false, tested: 'no record in fixture' });
        continue;
      }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const button = page.getByRole('main').getByTestId('share-whatsapp').first();
      const has = await button.isVisible({ timeout: 30_000 }).catch(() => false);
      if (!has) {
        missing.push(`${entry.page} ${url}`);
        matrix.push({ page: entry.page, url, button: false, dialog: false, rows: 0, pdf: false, link: false, filters: false, selectedRows: false, tested: 'FAIL' });
        continue;
      }
      await button.click();
      const dialog = page.getByTestId('share-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(dialog.getByTestId('share-summary')).toContainText(/row/, { timeout: 45_000 });
      const summary = await dialog.getByTestId('share-summary').innerText();
      const rows = Number(/^([\d,]+) row/.exec(summary)?.[1]?.replace(/,/g, '') ?? '0');
      const nothing = (await dialog.getByText('There is nothing in this selection to share.').count()) > 0;
      const pdf = !nothing && (await dialog.getByTestId('share-download-pdf').isEnabled());
      matrix.push({
        page: entry.page,
        url,
        button: true,
        dialog: true,
        rows,
        pdf,
        link: !nothing && (await dialog.getByTestId('share-format-link').count()) > 0,
        filters: entry.kind === 'ledger' || entry.kind === 'list' || (await dialog.getByTestId('share-period').count()) > 0,
        selectedRows: (await dialog.getByTestId('share-choose-rows').count()) > 0,
        tested: nothing ? 'PASS (nothing to share yet)' : 'PASS',
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  } finally {
    if (process.env.SHARE_MATRIX_OUT) fs.writeFileSync(process.env.SHARE_MATRIX_OUT, JSON.stringify(matrix, null, 2));
    for (const row of matrix) console.log(`MATRIX | ${row.page} | ${row.url} | share ${row.button ? 'yes' : 'NO'} | rows ${row.rows} | PDF ${row.pdf ? 'yes' : '—'} | link ${row.link ? 'yes' : '—'} | filters ${row.filters ? 'yes' : '—'} | select ${row.selectedRows ? 'yes' : '—'} | ${row.tested}`);
    await page.close();
  }
  expect(missing, `pages without Share: ${missing.join(', ')}`).toEqual([]);
});
