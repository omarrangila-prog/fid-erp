import { test, type Page } from '@playwright/test';

/**
 * Not an assertion suite — it captures the product at the sizes people use it,
 * so a human can look at the result of a design change rather than trusting a
 * description of it. Run with `npm run e2e:shots`.
 */

const SHOTS: Array<{ path: string; name: string }> = [
  { path: '/dashboard', name: 'dashboard' },
  { path: '/purchases', name: 'purchases' },
  { path: '/inventory', name: 'inventory' },
  { path: '/sales/new', name: 'sale-form' },
  { path: '/accounting/journal/new', name: 'journal-voucher' },
  { path: '/reports/trial-balance', name: 'trial-balance' },
  { path: '/finance/receivables', name: 'receivables' },
];

const SIZES = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 834, height: 1112 },
  { label: 'desktop', width: 1440, height: 900 },
];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL!);
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|select-company/);
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/dashboard/);
  }
}

for (const size of SIZES) {
  test(`capture ${size.label}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);
    for (const shot of SHOTS) {
      await page.goto(shot.path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: `screenshots/${size.label}/${shot.name}.png`,
        fullPage: size.label !== 'mobile',
      });
    }
  });
}

test('capture the sign-in screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.screenshot({ path: 'screenshots/desktop/login.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.screenshot({ path: 'screenshots/mobile/login.png' });
});
