import { test, expect, type Page } from '@playwright/test';

/**
 * The second sweep: the places the first one could not reach.
 *
 * The first audit signed in as the owner, in Dubai, on a desktop, and looked
 * at text. Most of what a client actually trips over lives outside that: the
 * other company, where a report has no data to show; the staff account, whose
 * permissions change what renders; a phone, where a fifteen-column table has
 * to become something readable; and the DOM itself, where a duplicated id
 * silently breaks a form label.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const STAFF_PIN = process.env.DUBAI_STAFF_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the deep audit.');
test.describe.configure({ mode: 'serial' });

async function pinIn(page: Page, name: string, pin: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
  for (const digit of pin.split('')) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/\/dashboard/, { waitUntil: 'domcontentloaded' });
  }
}

async function switchToMorocco(page: Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).first().click();
  await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
  await expect(page.getByText(/FID Trading International SARL/).first()).toBeVisible({ timeout: 20_000 });
}

const PAGES = [
  '/dashboard', '/purchases', '/sales', '/shipments', '/loading', '/inventory',
  '/inventory/batches', '/inventory/stock-counts', '/finance/receipts', '/finance/payments',
  '/finance/expenses', '/finance/cash-bank', '/finance/receivables', '/finance/payables',
  '/reports', '/reports/profit-loss', '/reports/balance-sheet', '/reports/trial-balance',
  '/reports/allocations', '/reports/stock-ageing', '/reports/expenses', '/reports/tax-return',
  '/customers', '/vendors', '/items', '/warehouses', '/ports',
];

/** Duplicated element ids: a real bug, and invisible until a label misfires. */
async function duplicateIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const counts = new Map<string, number>();
    for (const element of Array.from(document.querySelectorAll('[id]'))) {
      const id = element.id;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
  });
}

/** Inputs a screen reader would announce as nothing at all. */
async function unlabelledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea'),
    );

    for (const control of controls) {
      if (control.getAttribute('aria-label')) continue;
      if (control.getAttribute('aria-labelledby')) continue;
      if (control.closest('label')) continue;
      const id = control.getAttribute('id');
      if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) continue;
      if (control.getAttribute('type') === 'radio' || control.getAttribute('type') === 'checkbox') {
        // These are frequently labelled by a wrapping element's text.
        if (control.closest('label')) continue;
      }
      problems.push(
        `${control.tagName.toLowerCase()}${id ? `#${id}` : ''}${
          control.getAttribute('placeholder') ? ` [${control.getAttribute('placeholder')}]` : ''
        }`,
      );
    }
    return problems;
  });
}

test('every page is valid enough to be operable', async ({ page }) => {
  test.setTimeout(600_000);
  await pinIn(page, ADMIN_NAME, ADMIN_PIN!);

  const problems: string[] = [];

  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    for (const duplicate of await duplicateIds(page)) {
      problems.push(`${path}: duplicated id ${duplicate}`);
    }
    for (const control of await unlabelledControls(page)) {
      problems.push(`${path}: control with no accessible name — ${control}`);
    }
  }

  expect(problems, problems.join('\n')).toEqual([]);
});

test('Morocco renders every screen, including the ones with no data', async ({ page }) => {
  test.setTimeout(600_000);
  await pinIn(page, ADMIN_NAME, ADMIN_PIN!);
  await switchToMorocco(page);

  const problems: string[] = [];

  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const text = await page.locator('body').innerText();
    if (/this page could|something went wrong/i.test(text)) {
      problems.push(`${path}: rendered an error boundary in Morocco`);
    }
    if (/\bNaN\b|Invalid Date|\[object Object\]/.test(text)) {
      problems.push(`${path}: ${text.match(/\bNaN\b|Invalid Date|\[object Object\]/)?.[0]} in Morocco`);
    }
  }

  expect(problems, problems.join('\n')).toEqual([]);
});

test('a data-entry operator sees no broken screen either', async ({ page }) => {
  test.setTimeout(600_000);
  test.skip(!STAFF_PIN, 'Set DUBAI_STAFF_PIN.');
  await pinIn(page, 'Dubai Staff', STAFF_PIN!);

  const problems: string[] = [];

  // Only what their role permits; the rest correctly redirects.
  for (const path of ['/dashboard', '/purchases', '/sales', '/loading', '/inventory',
    '/finance/expenses', '/finance/receipts', '/customers', '/vendors', '/items']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    if (page.url().includes('/unauthorized')) continue;

    const text = await page.locator('body').innerText();
    if (/this page could|something went wrong/i.test(text)) {
      problems.push(`${path}: error boundary for a data-entry operator`);
    }
    if (/\bNaN\b|Invalid Date|\[object Object\]/.test(text)) {
      problems.push(`${path}: broken value for a data-entry operator`);
    }
  }

  expect(problems, problems.join('\n')).toEqual([]);
});

test('nothing overflows or hides on a phone', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await pinIn(page, ADMIN_NAME, ADMIN_PIN!);

  const problems: string[] = [];

  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    });
    // A couple of pixels is rounding; a column poking out is not.
    if (overflow.scrollWidth > overflow.clientWidth + 2) {
      problems.push(`${path}: scrolls sideways at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`);
    }

    const text = await page.locator('body').innerText();
    if (/this page could|something went wrong/i.test(text)) {
      problems.push(`${path}: error boundary on a phone`);
    }
  }

  expect(problems, problems.join('\n')).toEqual([]);
});
