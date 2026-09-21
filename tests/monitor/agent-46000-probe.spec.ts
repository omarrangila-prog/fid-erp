import { test, expect, type Page } from '@playwright/test';

/**
 * Read-only: where does the MAD 46,000 agent collection (RV 22, BANI,
 * collected by RADOUAN MOHAMMED) appear, how many times, and in what currency?
 * Opens pages and reads text. Clicks nothing that writes.
 */
const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';
test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    if (await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) break;
  }
  for (const digit of (ADMIN_PIN ?? '').split('')) await page.getByRole('button', { name: digit, exact: true }).first().click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
}

const PAGES = (process.env.PROBE_PAGES ?? '').split(',').filter(Boolean);

test('where MAD 46,000 appears', async ({ page }) => {
  await signIn(page);
  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    const rows = await page.locator('main tr, main li, main [role=row]').allInnerTexts();
    const hits = rows.map((r) => r.replace(/\s+/g, ' ').trim()).filter((r) => /46,000|4,791\.67|4,670\.05/.test(r));
    console.log(`\n=== ${path} — ${hits.length} row(s)`);
    for (const h of hits) console.log('   ', h.slice(0, 260));
  }
});
