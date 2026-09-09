import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * WCAG 2 A and AA, checked with axe on the screens people spend their day in.
 *
 * Automated checking catches contrast, labelling, landmarks and ARIA misuse —
 * not everything, but everything that can be measured without a human.
 */

const PAGES = [
  '/dashboard',
  '/purchases',
  '/sales/new',
  '/inventory',
  '/finance/receipts/new',
  '/reports/trial-balance',
  '/accounting/journal/new',
  '/customers',
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

test('the sign-in page has no accessibility violations', async ({ page }) => {
  await page.goto('/login');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    JSON.stringify(results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html.slice(0, 120)) })), null, 2),
  ).toEqual([]);
});

for (const path of PAGES) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await signIn(page);
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(
      results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
      JSON.stringify(
        results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)),
        })),
        null,
        2,
      ),
    ).toEqual([]);
  });
}
