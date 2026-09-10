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

test('the Excel button on the loading sheet points at the workbook', async ({ page }) => {
  await page.goto('/loading');
  const link = page.getByRole('link', { name: 'Excel' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/api/export/loading-sheet');
  await expect(link).toHaveAttribute('download', '');
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
