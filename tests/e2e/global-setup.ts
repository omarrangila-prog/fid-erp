import { execFileSync } from 'node:child_process';

/**
 * Runs once before the browser suite: empties the test database, provisions
 * it, and puts the fixture trade in. Refuses to run at all unless
 * TEST_DATABASE_URL is set and names a test database, so the suite cannot be
 * pointed at the books by leaving one variable unset.
 */
export default function globalSetup() {
  const url = process.env.TEST_DATABASE_URL ?? '';
  const databaseName = url.replace(/\?.*$/, '').split('/').pop() ?? '';
  if (!url || !/test/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must be set to a database whose name contains "test" before the browser suite runs.',
    );
  }

  execFileSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'scripts/e2e-fixture.ts', '--reset'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
