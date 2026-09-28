import { test, expect, type Page } from '@playwright/test';
import { chooseCompany } from './settle';

/**
 * The frame around every screen: the menu stays put while the page scrolls,
 * and the screens opened lately are tabs one click away.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run this suite.');
test.setTimeout(180_000);

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await chooseCompany(page, /FID Trading International SARL/);
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('the menu stays on screen while a long page scrolls', async ({ page }) => {
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  const menu = page.getByRole('navigation', { name: 'Main' }).first();
  await expect(menu).toBeVisible({ timeout: 45_000 });
  const before = await menu.boundingBox();
  // Make the page long whatever the data, then scroll well down it.
  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.style.height = '4000px';
    document.querySelector('main')?.appendChild(filler);
    window.scrollTo(0, 2500);
  });
  await page.waitForTimeout(400);
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(1000);
  const after = await menu.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  await expect(menu).toBeInViewport();
  console.log(`  page scrolled ${scrolled}px; the menu stayed at ${after?.y}px`);
});

test('screens opened become tabs: switch, close, and they are still there after a reload', async ({ page }) => {
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1500);
  await page.goto('/agents', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1500);

  const bar = page.getByTestId('recent-tabs');
  await expect(bar.getByTestId('recent-tab').filter({ hasText: /^Sales$/ })).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByTestId('recent-tab').filter({ hasText: /^Agents$/ })).toHaveAttribute('aria-current', 'page');

  // Back to Sales by its tab.
  await bar.getByTestId('recent-tab').filter({ hasText: /^Sales$/ }).click();
  await page.waitForURL(/\/sales$/, { timeout: 30_000 });

  // A reload keeps them.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('recent-tabs').getByTestId('recent-tab').filter({ hasText: /^Agents$/ })).toBeVisible({ timeout: 30_000 });

  // Closing one removes it.
  await page.getByRole('button', { name: 'Close Agents' }).click();
  await expect(page.getByTestId('recent-tabs').getByTestId('recent-tab').filter({ hasText: /^Agents$/ })).toHaveCount(0);
});
