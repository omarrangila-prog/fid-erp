import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Migrations need a *direct* connection. Supabase's transaction pooler (port
 * 6543) cannot run the advisory locks and session state that `prisma migrate`
 * relies on, so set DIRECT_URL to the direct or session-pooler string and
 * leave DATABASE_URL pointing at whichever connection the application uses.
 *
 * The URL is read here rather than through prisma's `env()` helper, which
 * resolves eagerly and throws when the variable is absent. `prisma generate`
 * needs no database at all, and on a serverless host it runs during
 * `npm install` — before any environment variables exist — so an eager lookup
 * failed the build for a step that never needed the value. An empty string is
 * harmless: `generate` ignores it, and `migrate` is only ever run from a shell
 * that has the real one.
 */
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: migrationUrl,
  },
});
