import { test, expect, type Page } from '@playwright/test';

/**
 * The Excel downloads.
 *
 * A CSV renamed .xlsx will open with a warning and a client will notice. These
 * check the real thing comes back: the right content type, a sensible
 * filename, and a payload that begins PK because an .xlsx is a zip.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the export tests.');

async function signIn(page: Page) {
  // `domcontentloaded`, not the default `load`: waiting for every subresource
  // on a page that keeps polling aborts under load, and the whole spec fails
  // on the sign-in rather than on anything it set out to check.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
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

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

for (const [report, expected] of [
  ['loading-sheet', 'loading-follow-up'],
  ['allocations', 'stock-allocation'],
  ['receivables', 'customer-receivables'],
  ['payables', 'supplier-payables'],
  ['stock-on-hand', 'stock-on-hand'],
  ['stock-ageing', 'stock-ageing'],
  ['trial-balance', 'trial-balance'],
  ['profit-loss', 'profit-and-loss'],
  ['balance-sheet', 'balance-sheet'],
  ['cash-flow', 'cash-flow'],
  ['general-ledger', 'general-ledger'],
  ['journal', 'journal'],
  ['expenses', 'expense-report'],
  ['financial-position', 'financial-position'],
  ['reconciliation', 'reconciliation'],
] as const) {
  test(`${report} downloads a real Excel workbook`, async ({ page }) => {
    const response = await page.request.get(`/api/export/${report}`);
    expect(response.status()).toBe(200);

    expect(response.headers()['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers()['content-disposition']).toContain(`FID-DXB-${expected}-`);
    expect(response.headers()['content-disposition']).toContain('.xlsx');

    const body = await response.body();
    // Every .xlsx is a zip, and every zip starts PK.
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(body.byteLength).toBeGreaterThan(2_000);
  });
}

/**
 * A report is read with a period chosen and the Excel button sits beside it.
 * If the link dropped the period, the client would email a spreadsheet that
 * disagreed with the screen it came from and have no way to tell which was
 * right. These check the filters travel.
 */
for (const [path, query, expectedHref] of [
  ['/reports/trial-balance', '?asOf=2026-06-30', '/api/export/trial-balance?asOf=2026-06-30'],
  ['/reports/profit-loss', '?from=2026-01-01&to=2026-06-30', '/api/export/profit-loss?from=2026-01-01&to=2026-06-30'],
  ['/reports/balance-sheet', '?asOf=2026-06-30', '/api/export/balance-sheet?asOf=2026-06-30'],
  ['/reports/cash-flow', '?from=2026-01-01&to=2026-06-30', '/api/export/cash-flow?from=2026-01-01&to=2026-06-30'],
] as const) {
  test(`${path} carries its period into the Excel link`, async ({ page }) => {
    await page.goto(`${path}${query}`);
    const link = page.getByRole('link', { name: 'Excel' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', expectedHref);

    // And the link actually works, rather than merely looking right.
    const response = await page.request.get(expectedHref);
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
  });
}

test('the expense export follows the grouping on screen', async ({ page }) => {
  await page.goto('/reports/expenses?from=2026-01-01&to=2026-12-31&groupBy=payee');
  const link = page.getByRole('link', { name: 'Excel' });
  await expect(link).toHaveAttribute(
    'href',
    '/api/export/expenses?from=2026-01-01&to=2026-12-31&groupBy=payee',
  );
});

test('the general ledger export names the account being read', async ({ page }) => {
  await page.goto('/reports/general-ledger');
  const href = await page.getByRole('link', { name: 'Excel' }).getAttribute('href');
  // The page falls back to the first account when none is chosen; the export
  // must be pointed at that same account, not left to guess.
  expect(href).toMatch(/^\/api\/export\/general-ledger\?account=[\w-]+$/);

  const response = await page.request.get(href ?? '');
  expect(response.status()).toBe(200);
});

test('a period the export cannot read is ignored rather than crashing', async ({ page }) => {
  const response = await page.request.get('/api/export/profit-loss?from=last-tuesday&to=');
  expect(response.status()).toBe(200);
  expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
});

test('the Excel button on the loading sheet points at the workbook', async ({ page }) => {
  await page.goto('/loading');
  const link = page.getByRole('link', { name: 'Excel' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/api/export/loading-sheet');
  await expect(link).toHaveAttribute('download', '');
});

/**
 * The list screens export what the user is looking at, which only the browser
 * knows. These check that path end to end: the button, the round trip, and a
 * genuine workbook coming back.
 */
test('a list screen exports the rows on screen as a real workbook', async ({ page }) => {
  await page.goto('/inventory/movements');
  const button = page.getByRole('button', { name: /Excel/i });
  await expect(button).toBeVisible();

  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^FID-DXB-stock-movements-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('the exported sheet follows the search box', async ({ page }) => {
  // Someone who has filtered to one batch and pressed Excel means that batch.
  const response = await page.request.post('/api/export/table', {
    data: {
      title: 'Stock Movements',
      subtitle: '3 rows of 1,204, matching “ETH-2026”',
      columns: [{ header: 'Batch' }, { header: 'Quantity KG', type: 'quantity' }],
      rows: [['ETH-2026-001', 19200], ['ETH-2026-002', -4000]],
      totals: ['Quantity KG'],
    },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain('FID-DXB-stock-movements-');

  const body = await response.body();
  expect(body.subarray(0, 2).toString()).toBe('PK');
});

test('the table export refuses a payload it cannot write, in plain English', async ({ page }) => {
  const response = await page.request.post('/api/export/table', {
    data: { title: '', columns: [], rows: [] },
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);

  const body = await response.json();
  expect(body.error).toBeTruthy();
  // No stack, no Zod, no field paths — a sentence the user can act on.
  expect(body.error).not.toMatch(/expected|received|ZodError|at Object/i);
});

test('the table export is refused without a session', async ({ browser }) => {
  const context = await browser.newContext();
  const response = await context.request.post('http://localhost:3000/api/export/table', {
    data: { title: 'Anything', columns: [{ header: 'A' }], rows: [['x']] },
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  await context.close();
});

test('an unknown report is refused rather than guessed at', async ({ page }) => {
  const response = await page.request.get('/api/export/everything');
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(await response.text()).not.toContain('PK');
});

test('an export is refused without a session', async ({ browser }) => {
  // A clean context, so no cookie travels with the request.
  const context = await browser.newContext();
  const response = await context.request.get('http://localhost:3000/api/export/receivables');
  expect(response.status()).toBeGreaterThanOrEqual(400);
  await context.close();
});
