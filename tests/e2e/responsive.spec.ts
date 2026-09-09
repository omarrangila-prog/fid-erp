import { test, expect, type Page } from '@playwright/test';

/**
 * Layout audit in a real browser.
 *
 * The rules here are the ones a person notices immediately: the page scrolls
 * sideways, a button is cut off, text is too small to read, a tap target is
 * too small to hit. Each is checked by measuring the rendered page rather than
 * by eye, so a regression fails the build instead of waiting to be spotted.
 */

const WIDTHS = [
  320, 360, 375, 390, 412, 430, 480, // phones
  600, 768, 820, 834, 1024,          // tablets
  1280, 1366, 1440,                  // laptops
  1536, 1600, 1920, 2560,            // desktops
];

const PAGES = [
  '/dashboard',
  '/purchases',
  '/sales',
  '/inventory',
  '/finance/receivables',
  '/reports/trial-balance',
  '/accounting/journal/new',
  '/customers',
  '/shipments',
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

/** Elements wider than the viewport, which is what causes sideways scrolling. */
async function overflowingElements(page: Page, width: number) {
  return page.evaluate((w) => {
    const bad: Array<{ tag: string; cls: string; right: number }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed') continue;
      // An element inside its own horizontal scroller is allowed to be wide.
      let parent = el.parentElement;
      let scrollable = false;
      while (parent && parent !== document.body) {
        const ps = getComputedStyle(parent);
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflowX === 'hidden') { scrollable = true; break; }
        parent = parent.parentElement;
      }
      if (scrollable) continue;
      if (rect.right > w + 1) {
        bad.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 90) ?? '', right: Math.round(rect.right) });
      }
    }
    return bad.slice(0, 5);
  }, width);
}

test.describe('no horizontal overflow at any supported width', () => {
  for (const width of WIDTHS) {
    test(`${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);

      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
        const offenders = await overflowingElements(page, width);

        expect(
          scrollWidth,
          `${path} at ${width}px scrolls sideways (${scrollWidth} > ${clientWidth}). Offenders: ${JSON.stringify(offenders)}`,
        ).toBeLessThanOrEqual(clientWidth + 1);
      }
    });
  }
});

test.describe('mobile ergonomics', () => {
  test('tap targets are large enough at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);

    for (const path of ['/dashboard', '/purchases', '/sales']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      const small = await page.evaluate(() => {
        const out: string[] = [];
        const targets = document.querySelectorAll<HTMLElement>('a[href], button, input, select, [role="button"]');
        for (const el of Array.from(targets)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (getComputedStyle(el).visibility === 'hidden') continue;
          if (r.height < 30 || r.width < 24) {
            out.push(`${el.tagName.toLowerCase()}.${el.className?.toString().slice(0, 50)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return out.slice(0, 6);
      });

      expect(small, `${path} has controls too small to tap: ${JSON.stringify(small)}`).toHaveLength(0);
    }
  });

  test('text is never smaller than 11px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    const tiny = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (!el.textContent?.trim()) continue;
        if (el.children.length > 0) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 11) out.push(`${size}px: ${el.textContent.trim().slice(0, 40)}`);
      }
      return out.slice(0, 6);
    });

    expect(tiny, `text below 11px: ${JSON.stringify(tiny)}`).toHaveLength(0);
  });

  test('the navigation drawer opens and covers content properly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/dashboard');

    await page.getByRole('button', { name: /more/i }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    const box = await drawer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    expect(box!.x).toBeGreaterThanOrEqual(0);
  });
});
