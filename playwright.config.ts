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

/*
 * The developer the share-activity tests sign in as. The PIN is drawn afresh
 * for each run — four digits, none of the easy ones and none of the PINs the
 * other accounts use — and passed to the fixture, the server and the specs
 * through the environment, so it is never written down.
 */
function drawPin(taken: Array<string | undefined>): string {
  for (;;) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    if (/^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '9876'].includes(pin) || taken.includes(pin)) continue;
    return pin;
  }
}
process.env.E2E_DEVELOPER_EMAIL ??= 'developer@e2e.fid.invalid';
process.env.E2E_DEVELOPER_PIN ??= drawPin([process.env.ADMIN_PIN, process.env.DUBAI_STAFF_PIN, process.env.MOROCCO_STAFF_PIN]);

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'npx next start -p 3000',
    url: 'http://localhost:3000/login',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, DEVELOPER_USERS: process.env.E2E_DEVELOPER_EMAIL ?? '' },
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
