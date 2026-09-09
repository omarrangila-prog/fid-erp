import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests run against TEST_DATABASE_URL, a database that is truncated
 * between suites. File parallelism is disabled because the suites share that
 * one database and posting order matters.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` is a build-time guard for the Next.js bundler and has no
      // meaning under Vitest, where there is no client bundle to protect.
      'server-only': path.resolve(here, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'admin@test.local',
      INITIAL_ADMIN_NAME: 'Test Admin',
      INITIAL_ADMIN_PASSWORD: 'TestAdmin!2026',
    },
  },
});
