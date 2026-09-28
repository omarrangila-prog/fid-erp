import { test, expect, type Page } from '@playwright/test';

/**
 * Every shipment page reads like ICUL/FID/002's: the order's reference as the
 * title, the same sections in the same order, amounts in the currency they
 * happened in with the other underneath. Opened from any of its containers,
 * a shipment shows all of them.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const MOROCCO = /FID Trading International SARL/i;
const SECTIONS = ['Shipment costing', 'Shipment profitability', 'Batches and containers', 'Logistics', 'Sales invoices from this shipment', 'Shipment costs', 'History'];

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run.');

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  // The PIN alone signs in: no name to pick.
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible({ timeout: 60_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) await page.getByRole('button', { name: digit, exact: true }).first().click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if ((await switcher.count()) && !MOROCCO.test((await switcher.textContent()) ?? '')) {
    await switcher.click();
    await page.getByRole('menuitem', { name: MOROCCO }).click();
    await page.waitForLoadState('domcontentloaded');
  }
}

test('every shipment page has the same sections, in the same order', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto('/shipments', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const hrefs = [...new Set(await page.locator('a[href^="/shipments/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')!)))]
    .filter((href) => /^\/shipments\/[\w-]+$/.test(href) && !href.endsWith('/new'))
    .slice(0, 6);
  expect(hrefs.length).toBeGreaterThan(0);

  for (const href of hrefs) {
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const main = page.getByRole('main');
    const text = (await main.innerText()).replace(/\s+/g, ' ');
    // The title is the order's reference, with no "Shipment 2 of 3".
    const title = ((await page.getByRole('heading', { level: 1 }).first().textContent()) ?? '').trim();
    expect(title, href).not.toMatch(/Shipment \d+ of \d+/);
    // The same sections, in the same order.
    let last = -1;
    for (const section of SECTIONS) {
      const at = text.indexOf(section);
      expect(at, `${href} has "${section}"`).toBeGreaterThan(-1);
      expect(at, `${href} has "${section}" after the one before`).toBeGreaterThan(last);
      last = at;
    }
    // Amounts carry their equivalent.
    expect(text, `${href} shows equivalents`).toMatch(/≈ (USD|MAD) [\d,]+\.\d{2}/);
    console.log(`  ${title}: sections in order, equivalents shown`);
  }
});
