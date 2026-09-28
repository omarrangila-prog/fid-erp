import { test, expect } from '@playwright/test';

// Three legitimate homepages name the company three ways: the management
// dashboard greets you, an empty company shows the setup checklist, and a
// data-entry operator gets a work queue. All three say which company you are
// in, which is what these tests are actually asserting.
const onCompany = (name: string) => new RegExp(`(happening at|Welcome to|working in) ${name}`);

/**
 * PIN-only sign-in, driven the way a person uses it: open the app, tap four
 * digits, land in your own company. No name, no email, no password — the PIN
 * says who you are.
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

async function pinIn(page: import('@playwright/test').Page, pin: string) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible({ timeout: 45_000 });
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

test('the sign-in screen asks for a PIN and nothing else', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pin-login')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
  // No names to pick, no email, no password.
  await expect(page.getByLabel(/email/i)).toHaveCount(0);
  await expect(page.getByText(/Who is signing in/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /password/i })).toHaveCount(0);
});

test('the owner signs in with the PIN alone', async ({ page }) => {
  await pinIn(page, ADMIN_PIN);
  await page.waitForURL(/dashboard|select-company/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
});

test('Dubai staff land in Dubai', async ({ page }) => {
  await pinIn(page, DUBAI_PIN);
  await page.waitForURL(/dashboard/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  await expect(page.getByText(onCompany('FID Trading L\\.L\\.C\\.'))).toBeVisible();
});

test('Morocco staff land in Morocco', async ({ page }) => {
  await pinIn(page, MOROCCO_PIN);
  await page.waitForURL(/dashboard/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  await expect(page.getByText(onCompany('FID Trading International SARL'))).toBeVisible();
});

test('a wrong PIN says "Incorrect PIN" and nothing more', async ({ page }) => {
  // A PIN nobody here has.
  const wrong = ['7039', '5182', '6274', '8305'].find((pin) => ![ADMIN_PIN, DUBAI_PIN, MOROCCO_PIN].includes(pin))!;
  await pinIn(page, wrong);
  await expect(page.getByTestId('pin-error')).toHaveText('Incorrect PIN', { timeout: 30_000 });
  expect(page.url()).toContain('/login');
});

test('logout returns to the PIN screen, and Back does not reopen the pages', async ({ page }) => {
  await pinIn(page, MOROCCO_PIN);
  await page.waitForURL(/dashboard/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  await page.goto('/sales', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
});
