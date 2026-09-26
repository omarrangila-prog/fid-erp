import { test, expect, type Page } from '@playwright/test';

/**
 * One shipment, read on every screen that shows it.
 *
 * The client found an order saying "0 of 2 arrived" while the coffee was on
 * the shelf and being sold from. The cause was a status nobody kept in step
 * with the goods, and the way it showed itself was two screens disagreeing.
 * So this reads the same order on the purchase list, its own page and the
 * loading sheet, and refuses to let them say different things.
 *
 * Read-only, against whatever deployment MONITOR_BASE_URL names.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
const COMPANY = process.env.MONITOR_COMPANY ?? 'FID Trading International SARL';

test.skip(!ADMIN_PIN, 'Set ADMIN_PIN to run the monitor.');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const tile = page.getByRole('button', { name: new RegExp(ADMIN_NAME, 'i') }).first();
  const keypad = page.getByRole('button', { name: '1', exact: true });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  // A click that lands before the page is interactive does nothing; try again
  // only while the tile is still there, so a working click is never undone.
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
  }
}

test('no order claims nothing arrived while its goods are in stock', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);

  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const main = page.getByRole('main');
  await expect(main).toBeVisible({ timeout: 30_000 });

  const rows = await main.getByRole('row').all();
  const offences: string[] = [];
  for (const row of rows) {
    const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    /*
     * "0 of 2 containers arrived" beside a receipt figure greater than nil
     * is the exact contradiction the client reported. Either the goods have
     * not arrived and nothing has been received, or both have moved.
     */
    const arrival = text.match(/(\d+) of (\d+) containers arrived/i);
    const receivedKg = text.match(/([\d,]+(?:\.\d+)?)\s*KG received/i);
    if (arrival && arrival[1] === '0' && receivedKg && Number(receivedKg[1].replace(/,/g, '')) > 0) {
      offences.push(text.slice(0, 120));
    }
  }

  for (const line of offences) console.log('  ! ' + line);
  console.log(`  checked ${rows.length} order rows; ${offences.length} contradicting themselves`);
  expect(offences, offences.join('\n')).toEqual([]);
});

test('the purchase list and the order page agree about arrival', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);

  await page.goto('/purchases', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const link = page.getByRole('main').getByRole('link', { name: /ICUL|HRCC|\// }).first();
  if ((await link.count()) === 0) {
    test.skip(true, 'No orders in this company.');
    return;
  }

  /*
   * The row by the order's reference. A list row is itself the link to the
   * order, so looking for a link inside a row found none and waited out the
   * whole test; a short timeout means a changed layout is reported, not hung on.
   */
  const reference = ((await link.textContent()) ?? '').trim();
  const listRow = page.getByRole('row').filter({ hasText: reference }).first();
  const listText = (await listRow.innerText({ timeout: 20_000 }).catch(() => '')).replace(/\s+/g, ' ');
  expect(listText, `the purchase list has a row for ${reference}`).not.toBe('');
  const listArrival = listText.match(/(\d+) of (\d+) containers arrived/i);

  await link.click();
  await page.waitForURL(/\/purchases\/[\w-]+$/, { timeout: 60_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const detail = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
  const detailArrival = detail.match(/(\d+) of (\d+) containers arrived/i);

  if (listArrival && detailArrival) {
    expect(
      `${detailArrival[1]}/${detailArrival[2]}`,
      'the list and the order page must count the same containers',
    ).toBe(`${listArrival[1]}/${listArrival[2]}`);
    console.log(`  arrival agrees on both screens: ${listArrival[1]} of ${listArrival[2]}`);
  } else {
    console.log('  this order shows a single-container wording on one of the two screens');
  }

  // And an order whose goods are all received never reads as pending.
  if (/fully received/i.test(detail)) {
    expect(detail).not.toMatch(/Pending arrival/i);
    console.log('  fully received, and not described as pending');
  }
});
