import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * The browser suite runs against the production build on localhost, signed in
 * as a real user — the same path a person takes, not a mocked shell.
 *
 * It starts that server itself, on TEST_DATABASE_URL, after emptying the test
 * database and putting the fixture trade into it (tests/e2e/global-setup.ts).
 * It will not attach to a server that is already on the port: one run against
 * a server that happened to be pointed at the live books left a draft
 * purchase order in the client's data, and the only reliable way to make that
 * impossible is to never share the port.
 *
 * Build first: `npm run build`, then `npm run e2e`.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'npx next start -p 3000',
    url: 'http://localhost:3000/login',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  },
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One browser at a time. Three in parallel against a database in another
  // region occasionally lost the sign-in race and reported a failure that was
  // nothing to do with the code; serial costs under a minute and is reliable.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
