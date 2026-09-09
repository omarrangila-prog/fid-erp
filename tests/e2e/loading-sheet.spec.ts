import { test, expect, type Page } from '@playwright/test';

/**
 * The loading sheet and the allocation report.
 *
 * These are the two screens the client's brief is mostly about, so they are
 * checked as screens: the columns his paper sheet has, a table rather than a
 * grid of cards, the derived sold/unsold and payment positions, and the
 * drill-down from a shipment to the customers it was sold to.
 */

const ADMIN_PIN = process.env.ADMIN_PIN;
const DUBAI_PIN = process.env.DUBAI_STAFF_PIN;
const ADMIN_NAME = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';

test.skip(!ADMIN_PIN || !DUBAI_PIN, 'Set ADMIN_PIN and DUBAI_STAFF_PIN to run these.');

async function pinIn(page: Page, name: string, pin: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
  for (const digit of pin.split('')) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.waitForURL(/\/(dashboard|select-company)/);
  if (page.url().includes('select-company')) {
    await page.getByRole('link', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.waitForURL(/\/dashboard/);
  }
}

test.describe('the loading sheet', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await pinIn(page, ADMIN_NAME, ADMIN_PIN!);
  });

  test('is a table with the columns the paper sheet has', async ({ page }) => {
    await page.goto('/loading');

    for (const header of [
      'S/No', 'Contract date & ref', 'Exporter', 'Consignee',
      'Items description', 'Qty', 'Status', 'Containers', 'ETA', 'Documents',
    ]) {
      await expect(
        page.getByRole('columnheader', { name: header, exact: true }),
        `the Dubai sheet should have a ${header} column`,
      ).toBeVisible();
    }

    // A real table, not a grid of cards.
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('row').nth(1)).toBeVisible();
  });

  test('shows both the supplier reference and the FID number', async ({ page }) => {
    await page.goto('/loading');
    await expect(page.getByText(/DEMO-PO-ETH-2601/).first()).toBeVisible();
    await expect(page.getByText(/FID-DXB-PO-/).first()).toBeVisible();
  });

  test('fills in the consignee from the sale, and shows a derived payment position', async ({ page }) => {
    await page.goto('/loading');
    // The Ethiopian container was sold, so its consignee came from the invoice.
    await expect(page.getByText(/Emirates Specialty|Gulf Coffee|Al Marsa/).locator('visible=true').first()).toBeVisible();
    await expect(page.getByText(/Paid|Part paid|Overdue|Unpaid/).locator('visible=true').first()).toBeVisible();
  });

  test('drills from a shipment into the customers it was sold to', async ({ page }) => {
    await page.goto('/loading');
    await page.getByRole('button', { name: /View sales/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/purchased on/)).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Customer' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Outstanding' })).toBeVisible();
  });

  test('offers export and a compact density', async ({ page }) => {
    await page.goto('/loading');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /compact rows|comfortable rows/i }).click();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('uses the simpler Morocco columns in the Morocco company', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: /FID Trading L\.L\.C\./ }).first().click();
    await page.getByRole('menuitem', { name: /FID Trading International SARL/ }).click();
    await expect(page.getByText(/happening at FID Trading International SARL/)).toBeVisible({ timeout: 20_000 });

    await page.goto('/loading');
    for (const header of ['Company name', 'Container qty', 'B/L or container', 'Shipping line', 'Sold / left']) {
      await expect(
        page.getByRole('columnheader', { name: header, exact: true }),
        `the Morocco sheet should have a ${header} column`,
      ).toBeVisible();
    }
    // Dubai's container-centric columns are absent here.
    await expect(page.getByRole('columnheader', { name: 'Exporter', exact: true })).toHaveCount(0);
  });
});

test('the allocation report shows one purchase and what is left of it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinIn(page, ADMIN_NAME, ADMIN_PIN!);
  await page.goto('/reports/allocations');

  await expect(page.getByRole('heading', { name: 'Stock Allocation' })).toBeVisible();
  for (const label of ['Purchased', 'Sold', 'Reserved', 'Available']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText(/One purchase, many customers/)).toBeVisible();
  await expect(page.getByText(/Total sold/).first()).toBeVisible();
});

test('a data-entry operator lands on a work queue, not a dashboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinIn(page, 'Dubai Staff', DUBAI_PIN!);

  await expect(page.getByText(/Pick what you are entering/)).toBeVisible();
  await expect(page.getByRole('link', { name: /New purchase/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Loading sheet/ })).toBeVisible();
  await expect(page.getByText(/What you entered recently/)).toBeVisible();

  // None of the management figures.
  await expect(page.getByText(/Gross profit|Net profit|Cash position/i)).toHaveCount(0);
});
