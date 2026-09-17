import { test, expect } from '@playwright/test';

/**
 * What the sign-in screen actually does on the running deployment.
 *
 * Read-only. Clicks the user tile and reports what appears next, along with
 * anything the console or the network complained about, so a sign-in that
 * hangs can be told apart from a selector that is simply wrong.
 */

const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test('the sign-in screen offers a PIN keypad after choosing a user', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: /who is signing in/i })).toBeVisible({ timeout: 30_000 });

  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  await expect(tile).toBeVisible();
  await tile.click();

  // Give the next view a fair chance, then describe whatever is on screen.
  await page.waitForTimeout(5_000);

  const url = page.url();
  const buttons = await page.getByRole('button').allInnerTexts();
  const headings = await page.getByRole('heading').allInnerTexts();
  const inputs = await page.locator('input').evaluateAll((els) =>
    els.map((e) => {
      const i = e as HTMLInputElement;
      return `${i.type}${i.inputMode ? `/${i.inputMode}` : ''}${i.name ? ` name=${i.name}` : ''}${i.getAttribute('aria-label') ? ` aria=${i.getAttribute('aria-label')}` : ''}`;
    }),
  );

  console.log('\n--- after clicking the user tile ---');
  console.log('url      :', url);
  console.log('headings :', JSON.stringify(headings));
  console.log('buttons  :', JSON.stringify(buttons.map((b) => b.replace(/\s+/g, ' ').trim()).slice(0, 30)));
  console.log('inputs   :', JSON.stringify(inputs));
  console.log('console  :', console_.length ? console_ : 'clean');
  console.log('network  :', failures.length ? failures : 'clean');
});
