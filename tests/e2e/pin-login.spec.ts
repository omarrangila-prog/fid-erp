import { test, expect } from '@playwright/test';

/**
 * PIN sign-in, driven the way a person uses it: pick your name, tap four
 * digits, land in your own company.
 *
 * The PINs come from the environment rather than the file: they are real
 * credentials for the running system, and the repository is not where
 * credentials belong.
 */
const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
const DUBAI_PIN = process.env.DUBAI_STAFF_PIN ?? '';
const MOROCCO_PIN = process.env.MOROCCO_STAFF_PIN ?? '';

test.skip(
  !ADMIN_PIN || !DUBAI_PIN || !MOROCCO_PIN,
  'Set ADMIN_PIN, DUBAI_STAFF_PIN and MOROCCO_STAFF_PIN to run the PIN tests.',
);

async function pinIn(page: import('@playwright/test').Page, name: string, pin: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test('the administrator signs in with a PIN', async ({ page }) => {
  await pinIn(page, 'System Administrator', ADMIN_PIN);
  await page.waitForURL(/dashboard|select-company/, { timeout: 20_000 });
  expect(page.url()).toMatch(/dashboard|select-company/);
});

test('Dubai staff land in Dubai', async ({ page }) => {
  await pinIn(page, 'Dubai Staff', DUBAI_PIN);
  await page.waitForURL(/dashboard/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /FID Trading L\.L\.C\./ })).toBeVisible();
});

test('Morocco staff land in Morocco', async ({ page }) => {
  await pinIn(page, 'Morocco Staff', MOROCCO_PIN);
  await page.waitForURL(/dashboard/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /International SARL/ })).toBeVisible();
});

test('a wrong PIN is refused and does not sign anybody in', async ({ page }) => {
  await pinIn(page, 'Dubai Staff', '0000');
  await expect(page.getByRole('alert').first()).toContainText(/not correct/i);
  expect(page.url()).toContain('/login');
});

test("one person's PIN cannot open another person's account", async ({ page }) => {
  // Morocco's PIN, entered against the Dubai account, must fail.
  await pinIn(page, 'Dubai Staff', MOROCCO_PIN);
  await expect(page.getByRole('alert').first()).toContainText(/not correct/i);
});

test('a password route is still reachable', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: /password/i }).first().click();
  await page.waitForURL(/login\/password/);
  await expect(page.getByLabel(/email/i)).toBeVisible();
});
