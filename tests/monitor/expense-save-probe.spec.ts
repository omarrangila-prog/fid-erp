import { test, expect, type Page } from '@playwright/test';

/**
 * §33 — save a shipment cost on the running deployment and say what happens.
 *
 * This is the one probe in this folder that writes: the client cannot save a
 * cost and the logs alone have not settled why, so it does what they do. It
 * uses a token amount, marks the memo plainly as a probe, and deletes what
 * it created before it finishes. It runs only when asked for by name.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';
const MEMO = 'Probe — safe to delete, raised while diagnosing the save failure';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click().catch(() => undefined);
    const arrived = await keypad.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (arrived) break;
    if (!(await tile.isVisible().catch(() => false))) break;
  }
  await expect(keypad).toBeVisible({ timeout: 30_000 });
  for (const digit of (ADMIN_PIN ?? '').split('')) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: new RegExp(COMPANY, 'i') }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (await switcher.count()) {
    const label = (await switcher.textContent()) ?? '';
    if (!new RegExp(COMPANY, 'i').test(label)) {
      await switcher.click();
      await page.getByRole('menuitem', { name: new RegExp(COMPANY, 'i') }).click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

test('a shipment cost saves and posts', async ({ page }) => {
  test.setTimeout(300_000);

  // Everything the browser is told, so a failure can be read rather than guessed.
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url().slice(0, 120)}`);
  });

  await signIn(page);
  await page.goto('/finance/expenses/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const form = page.getByRole('main');
  await expect(form).toBeVisible({ timeout: 30_000 });

  // Filled the way the application's own browser tests fill it.
  await form.getByRole('combobox', { name: /contract \/ shipment/i }).click();
  const shipmentOption = page
    .getByRole('listbox')
    .getByRole('option', { name: /ICUL\/FID\/002/i })
    .or(page.getByRole('listbox').getByRole('option'))
    .first();
  await shipmentOption.click();

  await form.getByRole('combobox', { name: /expense category/i }).click();
  await page.getByRole('listbox').getByRole('option').first().click();

  await form.getByLabel(/^Amount/).first().fill('3');
  const rate = form.getByLabel(/Rate \(MAD per 1 USD\)/);
  if (await rate.count()) await rate.fill('9.85');
  await form.getByLabel(/^Memo/).first().fill(MEMO);

  // What the form is about to send, so a refusal can be read against it.
  console.log(`  amount field: ${await form.getByLabel(/^Amount/).first().inputValue()}`);

  const post = page.getByRole('button', { name: /Save and post/i });
  await expect(post).toBeEnabled({ timeout: 15_000 });
  const started = Date.now();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST', { timeout: 120_000 }).catch(() => null),
    post.click(),
  ]);
  console.log(`  POST came back ${response?.status() ?? '(never)'} after ${Date.now() - started}ms`);

  /*
   * Either it lands on the saved cost, or the page says why not. Both are
   * answers; hanging on the button is not, and that is what the client is
   * looking at.
   */
  // Not /new: that path also matches "a word", and an unsubmitted form
  // sitting where it started once read as a success.
  const landed = page
    .waitForURL((url) => /\/finance\/expenses\/[\w-]+$/.test(url.pathname) && !url.pathname.endsWith('/new'), {
      timeout: 120_000,
    })
    .then(() => 'saved' as const)
    .catch(() => 'stuck' as const);
  const refused = page
    .getByRole('alert')
    .first()
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => 'refused' as const)
    .catch(() => 'stuck' as const);

  const outcome = await Promise.race([landed, refused]);
  const alerts = await page.getByRole('alert').allTextContents();

  console.log(`  outcome: ${outcome}`);
  for (const alert of alerts) console.log(`  on screen: ${alert.replace(/\s+/g, ' ').slice(0, 300)}`);
  for (const problem of problems.slice(0, 10)) console.log(`  ! ${problem}`);

  if (outcome === 'saved') {
    console.log(`  saved at ${page.url()}`);
    // Take it straight back out: this was a probe, not a cost.
    const remove = page.getByRole('button', { name: /^Delete$/ }).first();
    if (await remove.count()) {
      await remove.click();
      const dialog = page.getByRole('dialog');
      const reason = dialog.getByLabel(/why/i).first();
      if (await reason.count()) await reason.fill('Probe entry, removed immediately');
      await dialog.getByRole('button', { name: /delete/i }).first().click();
      await expect(dialog).toHaveCount(0, { timeout: 60_000 });
      console.log('  probe expense deleted');
    }
  }

  expect(outcome, `${alerts.join(' | ')} ${problems.join(' | ')}`).toBe('saved');
});
