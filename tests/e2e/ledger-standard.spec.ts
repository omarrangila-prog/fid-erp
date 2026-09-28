import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * Every ledger is the same accounting report.
 *
 * Customer, supplier, agent, cash, bank, general ledger and unpaid expenses:
 * each shows Date, Memo, Debit, Credit and Balance under a bold header with
 * dark grid lines; on a phone it scrolls sideways inside itself without the
 * page overflowing; Customize adds a column that survives a reload and Reset
 * takes it away; printing shows the chosen columns on their own table.
 */

const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
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

/** Where each ledger lives: a list to pick the first entry from, or the ledger itself. */
const LEDGERS: Array<{ name: string; list?: string; link?: string; then?: string; url?: string; mayBeEmpty?: boolean }> = [
  { name: 'Customer ledger', list: '/ledgers/customers', link: 'a[href^="/ledgers/customers/"]' },
  { name: 'Supplier ledger', list: '/ledgers/vendors', link: 'a[href^="/ledgers/vendors/"]' },
  { name: 'Agent ledger', list: '/ledgers/agents', link: 'main a[href^="/agents/"]:has-text("E2E Settlement Agent")' },
  // The fixture pays through the bank; the cash drawers fill up as other suites run.
  { name: 'Cash ledger', list: '/finance/cash-bank', link: 'main a[href^="/finance/cash-bank/"]:has-text("Cash")', mayBeEmpty: true },
  { name: 'Bank ledger', list: '/finance/cash-bank', link: 'main a[href^="/finance/cash-bank/"]:has-text("Bank")' },
  // An account with activity: the bank's own account, opened from the bank page.
  { name: 'General ledger', list: '/finance/cash-bank', link: 'main a[href^="/finance/cash-bank/"]:has-text("Bank")', then: 'a[href^="/reports/general-ledger?account="]' },
  // The fixture books no unpaid cost; the other suites add them later.
  { name: 'Unpaid expenses ledger', url: '/finance/unpaid-expenses', mayBeEmpty: true },
];

const urls = new Map<string, string>();

async function open(page: Page, ledger: (typeof LEDGERS)[number]) {
  let url = urls.get(ledger.name) ?? ledger.url;
  if (!url) {
    await page.goto(ledger.list!, { waitUntil: 'domcontentloaded' });
    const links = page.locator(ledger.link!);
    await expect(links.first()).toBeAttached({ timeout: 45_000 });
    const hrefs = [...new Set(await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? '')))].filter(Boolean);
    // The first one with entries: an unused drawer has nothing to show.
    for (const first of hrefs) {
      let href = first;
      if (ledger.then) {
        await page.goto(first, { waitUntil: 'domcontentloaded' });
        const next = page.locator(ledger.then).first();
        await expect(next).toBeAttached({ timeout: 45_000 });
        href = (await next.getAttribute('href'))!;
      }
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('ledger-report').first()).toBeVisible({ timeout: 45_000 });
      url = href;
      if (await hasTable(page)) break;
    }
    urls.set(ledger.name, url!);
  }
  await page.goto(url!, { waitUntil: 'domcontentloaded' });
  const report = page.getByTestId('ledger-report').first();
  await expect(report).toBeVisible({ timeout: 45_000 });
  return report;
}

async function hasTable(page: Page) {
  return (await page.getByTestId('ledger-report').first().getByTestId('ledger-table').count()) > 0;
}

async function headers(page: Page) {
  return (await page.getByTestId('ledger-table').first().locator('thead th').allInnerTexts()).map((t) => t.trim().toUpperCase());
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
});

for (const ledger of LEDGERS) {
  test(`${ledger.name}: the standard layout on a desktop — columns, grid lines, customize, print`, async ({ page }) => {
    const report = await open(page, ledger);
    await expect(report.getByTestId('ledger-summary')).toContainText('Opening balance');
    await expect(report.getByTestId('ledger-summary')).toContainText('Closing balance');
    if (!(await hasTable(page))) {
      expect(ledger.mayBeEmpty, `${ledger.name} should have entries in the fixture`).toBe(true);
      // Nothing posted yet: the empty ledger still offers the same controls.
      await expect(report.getByTestId('ledger-customize')).toBeVisible();
      test.info().annotations.push({ type: 'note', description: `${ledger.name} is empty in this fixture` });
      console.log(`  ${ledger.name}: empty here — controls checked, table not`);
      return;
    }
    const cols = await headers(page);
    for (const core of ['DATE', 'MEMO', 'DEBIT', 'CREDIT', 'BALANCE']) expect(cols, ledger.name).toContain(core);

    // Dark lines between cells, not faint grey.
    const border = await page.getByTestId('ledger-table').first().locator('tbody td').first().evaluate((td) => getComputedStyle(td).borderRightColor);
    const [r, g, b] = (border.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
    expect(r + g + b, `${ledger.name} grid line ${border}`).toBeLessThan(300);

    // Numbers right-aligned.
    const align = await page.getByTestId('ledger-table').first().locator('td[data-col="balance"]').first().evaluate((td) => getComputedStyle(td).textAlign);
    expect(align).toBe('right');

    // Customize: add a column this ledger offers (JV No. where it has one), keep it after a reload, then reset.
    await report.getByTestId('ledger-customize').click();
    const panel = page.getByTestId('ledger-customize-panel');
    const jv = panel.getByRole('checkbox', { name: 'JV No.' });
    const label = (await jv.count()) ? 'JV No.' : ((await panel.getByRole('checkbox', { checked: false }).first().getAttribute('aria-label')) ?? '');
    const added = label.toUpperCase();
    // By name: once ticked it moves into the chosen list, so "the first unticked" would be another box.
    await panel.getByRole('checkbox', { name: label, exact: true }).check();
    await panel.getByTestId('ledger-customize-save').click();
    await expect(page.getByTestId('ledger-customize-panel')).toHaveCount(0, { timeout: 30_000 });
    expect(await headers(page)).toContain(added);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ledger-table').first()).toBeVisible({ timeout: 45_000 });
    expect(await headers(page), 'remembered after a reload').toContain(added);

    // Printing uses the chosen columns, on its own table.
    await page.emulateMedia({ media: 'print' });
    const printed = page.getByTestId('ledger-print').first();
    await expect(printed).toBeVisible();
    await expect(page.getByTestId('ledger-scroll').first()).toBeHidden();
    const printedHeads = (await printed.locator('thead th').allInnerTexts()).map((t) => t.trim().toUpperCase());
    expect(printedHeads).toContain(added);
    for (const core of ['DATE', 'MEMO', 'DEBIT', 'CREDIT', 'BALANCE']) expect(printedHeads).toContain(core);
    await page.emulateMedia({ media: 'screen' });

    await page.getByTestId('ledger-customize').first().click();
    await page.getByTestId('ledger-customize-reset').click();
    await expect(page.getByTestId('ledger-customize-panel')).toHaveCount(0, { timeout: 30_000 });
    expect(await headers(page)).not.toContain(added);
    console.log(`  ${ledger.name}: ${cols.length} columns, dark grid, "${label}" added, kept after reload, printed, reset`);
  });
}

for (const width of [360, 390, 430]) {
  test(`at ${width}px every ledger scrolls inside itself, never the page, with the accounting columns intact`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const ledger of LEDGERS) {
      await open(page, ledger);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${ledger.name} page overflow at ${width}px`).toBeLessThanOrEqual(1);
      if (!(await hasTable(page))) continue;
      const cols = await headers(page);
      for (const core of ['DATE', 'MEMO', 'DEBIT', 'CREDIT', 'BALANCE']) expect(cols, `${ledger.name} at ${width}px`).toContain(core);
      const scroll = page.getByTestId('ledger-scroll').first();
      // On a phone the ledger sits below the party's summary: bring it up first.
      await scroll.scrollIntoViewIfNeeded();
      const scrolled = await scroll.evaluate((el) => {
        el.scrollLeft = 10_000;
        return { left: el.scrollLeft, wide: el.scrollWidth > el.clientWidth };
      });
      if (scrolled.wide) {
        expect(scrolled.left, `${ledger.name} scrolls sideways`).toBeGreaterThan(0);
        // The date stays pinned at the left edge while the figures scroll.
        const [box, date] = await Promise.all([
          scroll.boundingBox(),
          page.getByTestId('ledger-table').first().locator('td[data-col="date"]').first().boundingBox(),
        ]);
        expect(Math.abs((date?.x ?? 0) - (box?.x ?? 0)), `${ledger.name} date pinned`).toBeLessThan(4);
        // And the balance can be brought into view.
        await expect(page.getByTestId('ledger-table').first().locator('td[data-col="balance"]').first()).toBeInViewport();
      }
    }
  });
}

test('compact view on a phone: one bordered card per row with debit, credit and balance', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, LEDGERS[2]);
  if (!(await hasTable(page))) test.skip(true, 'The agent ledger is empty in this fixture.');
  await page.getByTestId('ledger-view-compact').click();
  const card = page.getByTestId('ledger-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Debit');
  await expect(card).toContainText('Credit');
  await expect(card).toContainText('Balance');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByTestId('ledger-view-table').click();
  await expect(page.getByTestId('ledger-table').first()).toBeVisible();
});

for (const width of [768, 1920]) {
  test(`at ${width}px the ledgers fit the page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const ledger of LEDGERS) {
      await open(page, ledger);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${ledger.name} at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
}

test('choosing dates asks the server for them, and the balances follow', async ({ page }) => {
  await open(page, LEDGERS[2]);
  const summary = page.getByTestId('ledger-summary').first();
  const closing = (await summary.locator('dd').last().innerText()).trim();
  const rows = await page.getByTestId('ledger-row').count();
  expect(rows).toBeGreaterThan(0);

  // A date after every entry: nothing in the period, and the balance stands where it closed.
  await page.getByLabel('From date').fill('2099-01-01');
  await page.waitForURL(/from=2099-01-01/, { timeout: 30_000 });
  await expect(page.getByTestId('ledger-row')).toHaveCount(0, { timeout: 30_000 });
  await expect(summary.locator('dd').first()).toHaveText(closing);
  await expect(summary.locator('dd').last()).toHaveText(closing);

  // Cleared: every entry is back, still closing on the same figure.
  await page.getByLabel('From date').fill('');
  await page.waitForURL((url) => !url.searchParams.has('from'), { timeout: 30_000 });
  await expect(page.getByTestId('ledger-row')).toHaveCount(rows, { timeout: 30_000 });
  await expect(summary.locator('dd').last()).toHaveText(closing);
});
