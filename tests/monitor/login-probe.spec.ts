import { test, expect } from '@playwright/test';

/**
 * What the sign-in screen actually does on the running deployment.
 *
 * Read-only. Clicks the user tile and reports what appears next, along with
 * anything the console or the network complained about, so a sign-in that
 * hangs can be told apart from a selector that is simply wrong.
 */


test('the sign-in screen is the PIN keypad, and it loads cleanly', async ({ page }) => {
  const console_: string[] = [];
  const failures: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') console_.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console_.push('PAGEERROR ' + e.message.slice(0, 200)));
  page.on('requestfailed', (r) => failures.push(`${r.method()} ${r.url().slice(0, 120)} — ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url().replace(/https?:\/\/[^/]+/, '')}`);
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible({ timeout: 30_000 });
  // Every digit, and the keys become usable once the page is ready. No PIN is typed.
  for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    await expect(page.getByRole('button', { name: digit, exact: true })).toBeEnabled({ timeout: 30_000 });
  }
  await page.waitForLoadState('networkidle').catch(() => undefined);

  console.log('console  :', console_.length ? console_ : 'clean');
  console.log('network  :', failures.length ? failures : 'clean');
  expect(console_, 'no console errors on the sign-in screen').toEqual([]);
  expect(failures, 'no failed requests on the sign-in screen').toEqual([]);
});
