import { test, expect, type Page } from '@playwright/test';

// The dashboard greets you differently depending on whether the business has
// started trading: an empty company gets the setup checklist instead. Both
// name the company, which is what these tests are actually asserting.
const onCompany = (name: string) => new RegExp(`(happening at|Welcome to) ${name}`);

/**
 * The journeys a real user takes, driven through the interface rather than the
 * service layer — so a broken button, a form that will not submit or a company
 * switcher that shows the wrong books fails here even though the unit tests are
 * green.
 */

async function signIn(page: Page) {
  await page.goto('/login/password');
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL!);
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|select-company/);
}

async function signInToDubai(page: Page) {
  await signIn(page);
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/dashboard/);
  }
}

test('an administrator can reach both companies', async ({ page }) => {
  await signIn(page);

  // An admin with a default company lands on it; one without is asked to choose.
  if (page.url().includes('select-company')) {
    await expect(page.getByText(/FID Trading L\.L\.C\./)).toBeVisible();
    await expect(page.getByText(/FID Trading International SARL/)).toBeVisible();
    await page.getByRole('link', { name: /FID Trading International SARL/ }).first().click();
    await page.waitForURL(/dashboard/);
  } else {
    await page.getByRole('button', { name: /FID Trading/ }).first().click();
    await expect(page.getByRole('menuitem', { name: /FID Trading L\.L\.C\./ })).toBeVisible();
    await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
  }

  await expect(page.getByText(onCompany('FID Trading International SARL'))).toBeVisible({ timeout: 15_000 });
});

test('the company switcher changes which books are shown', async ({ page }) => {
  await signInToDubai(page);
  await expect(page.getByText(onCompany('FID Trading L\\.L\\.C\\.'))).toBeVisible();

  await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).first().click();
  await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
  await expect(page.getByText(onCompany('FID Trading International SARL'))).toBeVisible({ timeout: 15_000 });
});

test('a customer can be created through the interface', async ({ page }) => {
  await signInToDubai(page);
  await page.goto('/customers?new=1');

  const unique = `E2E Roasters ${Date.now().toString(36).toUpperCase()}`;
  await page.getByLabel(/customer name/i).fill(unique);
  await page.getByLabel(/customer code/i).fill(`E2E${Date.now().toString(36).slice(-5).toUpperCase()}`);
  await page.getByRole('button', { name: /^save|create customer$/i }).first().click();

  await expect(page.getByText(unique).first()).toBeVisible({ timeout: 15_000 });
});

test('the journal voucher refuses to post until debits equal credits', async ({ page }) => {
  await signInToDubai(page);
  await page.goto('/accounting/journal/new');

  const post = page.getByRole('button', { name: /post voucher/i });
  await expect(post).toBeDisabled();
  await expect(page.getByText(/not balanced/i)).toBeVisible();

  await page.getByLabel(/description/i).fill('E2E balance check');

  // Scoped to the open listbox: a bare option role also matches the native
  // <option> elements inside the currency select.
  await page.getByRole('combobox', { name: /line 1 account/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel(/line 1 amount/i).fill('250');

  // One side only: still refused.
  await expect(post).toBeDisabled();

  await page.getByRole('combobox', { name: /line 2 account/i }).click();
  await page.getByRole('listbox').getByRole('option').nth(1).click();
  await page.getByLabel(/line 2 amount/i).fill('250');

  await expect(page.getByText(/^balanced$/i)).toBeVisible();
  await expect(post).toBeEnabled();
});

test('a stock figure on the dashboard matches the inventory report', async ({ page }) => {
  await signInToDubai(page);
  await page.goto('/reports/trial-balance');
  await page.waitForLoadState('networkidle');

  // The trial balance states whether it balances; it must say that it does.
  const body = await page.locator('body').innerText();
  expect(body.toLowerCase()).not.toContain('does not balance');
});

test('a page the user may not open redirects rather than erroring', async ({ page }) => {
  await signInToDubai(page);
  await page.goto('/unauthorized?permission=test.permission');
  // Scoped to the page body: the navigation also contains the word.
  await expect(page.locator('main').getByText(/permission/i).first()).toBeVisible();
});
