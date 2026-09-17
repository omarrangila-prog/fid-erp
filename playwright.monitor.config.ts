import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * Read-only monitoring of a running FID deployment.
 *
 * Deliberately separate from `playwright.config.ts`. That one builds a world
 * of its own — it starts its own server on the test database and refuses to
 * share a port, because a run that once attached to a server pointed at the
 * live books left a draft purchase order in the client's data.
 *
 * This config is the opposite: it starts nothing, resets nothing, and points
 * at whatever deployment is named in MONITOR_BASE_URL. Everything under
 * tests/monitor only reads — it opens pages and reports what it sees. Nothing
 * in here may click Save, Post or Delete, because the target is the client's
 * live books while they are working in them.
 *
 *   MONITOR_BASE_URL=https://fid-erp.vercel.app npx playwright test -c playwright.monitor.config.ts
 */
const baseURL = process.env.MONITOR_BASE_URL ?? process.env.E2E_BASE_URL;

if (!baseURL) {
  throw new Error('Set MONITOR_BASE_URL to the deployment to watch, e.g. https://fid-erp.vercel.app');
}

export default defineConfig({
  testDir: './tests/monitor',
  // No webServer and no globalSetup: nothing is started, nothing is seeded,
  // and no database is emptied.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
