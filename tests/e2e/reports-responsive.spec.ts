import { test, expect, type Page } from '@playwright/test';
import { E2E_EMAIL, E2E_PASSWORD, PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS } from './credentials';
import { settle } from './settle';

test.skip(!PASSWORD_SIGN_IN_CONFIGURED, NO_PASSWORD_CREDENTIALS);

/**
 * The reports at the widths the reporting brief names (§28): no page scrolls
 * sideways (a wide table scrolls inside its own frame), the report says what
 * it is on screen (§22.1), and its figures are all inside the viewport or its
 * table's scroller — nothing clipped off the edge.
 */
const WIDTHS = [360, 390, 430, 768, 1366, 1920];
const REPORTS = [
  '/reports/profit-loss',
  '/reports/balance-sheet',
  '/reports/trial-balance',
  '/reports/general-ledger',
  '/reports/ageing',
  '/reports/ageing?side=payables',
  '/reports/cash-book',
  '/reports/inventory-valuation',
  '/reports/cogs',
  '/reports/shipment-cost',
  '/profitability',
  '/profitability?view=statement',
  '/inventory',
  '/inventory/batches',
  '/ledgers/customers',
  '/ledgers/vendors',
];

/** A load the sign-in redirect may still abort: wait, then load it once more. */
async function open(page: Page, path: string) {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  } catch {
    await page.waitForTimeout(1000);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
}

async function signInMorocco(page: Page) {
  await page.goto('/login/password');
  await page.getByLabel(/email/i).fill(E2E_EMAIL!);
  await page.getByLabel(/password/i).fill(E2E_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|select-company/, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('select-company')) {
    await page.getByRole('button', { name: /International SARL/ }).or(page.getByRole('link', { name: /International SARL/ })).first().click();
    await page.waitForURL(/dashboard/, { waitUntil: 'domcontentloaded' });
    return;
  }
  const switcher = page.getByRole('button', { name: /FID Trading/ }).first();
  if (!/International SARL/.test((await switcher.textContent()) ?? '')) {
    await switcher.click();
    await page.getByRole('menuitem', { name: /International SARL/ }).click();
    await page.waitForLoadState('domcontentloaded');
  }
}

for (const width of WIDTHS) {
  test(`reports at ${width}px: no sideways scroll, context shown`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 900 });
    await signInMorocco(page);
    const problems: string[] = [];
    for (const path of REPORTS) {
      await open(page, path);
      await settle(page);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth + 1) problems.push(`${path}: page scrolls sideways (${scrollWidth} > ${clientWidth})`);
      // Numbers cut off at the edge: a figure cell beyond the viewport that no scroller holds.
      const clipped = await page.evaluate((w) => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('td, th, dd'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.right <= w + 1) continue;
          let p = el.parentElement;
          let held = false;
          while (p && p !== document.body) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') { held = true; break; }
            p = p.parentElement;
          }
          if (!held) out.push(el.textContent?.trim().slice(0, 30) ?? '');
        }
        return out.slice(0, 3);
      }, width);
      if (clipped.length) problems.push(`${path}: cells cut off ${JSON.stringify(clipped)}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
