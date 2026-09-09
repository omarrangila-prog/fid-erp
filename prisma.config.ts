import 'dotenv/config';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

/**
 * Migrations need a *direct* connection. Supabase's transaction pooler (port
 * 6543) cannot run the advisory locks and session state that `prisma migrate`
 * relies on, so set DIRECT_URL to the direct or session-pooler string and
 * leave DATABASE_URL pointing at whichever connection the application uses.
 */
const migrationUrl = process.env.DIRECT_URL ? 'DIRECT_URL' : 'DATABASE_URL';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env(migrationUrl),
  },
});
