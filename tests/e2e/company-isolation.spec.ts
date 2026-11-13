import { test, expect, type Page } from '@playwright/test';

/**
 * PIN sign-in decides the company.
 *
 * A Pakistan operator's PIN opens FID Pakistan and nothing else; a Morocco
 * operator's opens FID Morocco and nothing else. Neither is offered the other
 * company, and a Morocco record typed straight into the address bar by the
 * Pakistan operator is not found — the server answers for the signed-in
 * company only, whatever the URL says.
 */
const ADMIN_PIN = process.env.ADMIN_PIN;
const MOROCCO_PIN = process.env.MOROCCO_STAFF_PIN;
const PAKISTAN_PIN = process.env.PAKISTAN_STAFF_PIN;
const MOROCCO = /FID Trading International SARL/i;
const PAKISTAN = /FID Pakistan/i;

test.skip(!ADMIN_PIN || !MOROCCO_PIN || !PAKISTAN_PIN, 'Set ADMIN_PIN, MOROCCO_STAFF_PIN and PAKISTAN_STAFF_PIN to run the isolation tests.');
test.describe.configure({ mode: 'serial' });

async function pinIn(page: Page, pin: string) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of pin.split('')) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
}

async function adminInMorocco(page: Page) {
  await pinIn(page, ADMIN_PIN!);
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: MOROCCO }).or(page.getByRole('link', { name: MOROCCO })).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
  const switcher = page.getByRole('button', { name: /FID / }).first();
  if (await switcher.count()) {
    if (!MOROCCO.test((await switcher.textContent()) ?? '')) {
      await switcher.click();
      await page.getByRole('menuitem', { name: MOROCCO }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

let moroccoCustomerUrl = '';
let moroccoCustomerName = '';

test('the owner finds a Morocco customer to try the door with', async ({ page }) => {
  await adminInMorocco(page);
  await page.goto('/customers', { waitUntil: 'domcontentloaded' });
  const link = page.locator('main a[href^="/customers/"]').filter({ hasText: /Casablanca/ }).first();
  await expect(link).toBeVisible({ timeout: 45_000 });
  moroccoCustomerUrl = (await link.getAttribute('href'))!;
  moroccoCustomerName = (await link.innerText()).trim();
  expect(moroccoCustomerUrl).toMatch(/^\/customers\/[a-z0-9]{20,}$/);
});

test('a Pakistan PIN opens FID Pakistan only', async ({ page }) => {
  await pinIn(page, PAKISTAN_PIN!);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(PAKISTAN).first()).toBeVisible({ timeout: 30_000 });
  // The other companies are not offered at all.
  await expect(page.getByText(MOROCCO)).toHaveCount(0);
  await expect(page.getByText(/FID Trading L\.L\.C\./)).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: MOROCCO })).toHaveCount(0);
});

test('a Pakistan user typing a Morocco record into the address bar gets nothing', async ({ page }) => {
  test.skip(!moroccoCustomerUrl, 'No Morocco customer found');
  await pinIn(page, PAKISTAN_PIN!);
  await page.goto(moroccoCustomerUrl, { waitUntil: 'domcontentloaded' });
  // The server looks the record up within the signed-in company only.
  await expect(page.getByRole('heading', { name: /does not exist/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(moroccoCustomerName)).toHaveCount(0);
  // And the company list still holds Pakistan only.
  await page.goto('/customers', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(moroccoCustomerName)).toHaveCount(0);
});

test('a Morocco PIN opens FID Morocco only', async ({ page }) => {
  await pinIn(page, MOROCCO_PIN!);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(MOROCCO).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(PAKISTAN)).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: PAKISTAN })).toHaveCount(0);
});
