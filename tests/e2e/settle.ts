import type { Page } from '@playwright/test';

/**
 * Wait until the page is worth measuring.
 *
 * These specs used `waitForLoadState('networkidle')`, which Playwright's own
 * documentation tells you not to do: it waits for a 500ms gap in network
 * activity, and an app that prefetches links or revalidates on focus may never
 * produce one. Under load it simply hung until the 90-second timeout — the
 * 768px width failed that way while the identical check at 820px passed, which
 * is the signature of a flake rather than a defect.
 *
 * What a layout measurement actually needs is narrower: the main content
 * rendered, the webfont swapped in (Inter arriving late reflows every text
 * box), and one frame for the browser to finish laying it out. That is
 * deterministic, and it is roughly ten times faster.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('main, [role="main"], body').first().waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
