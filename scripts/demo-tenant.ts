import 'dotenv/config';
import { prisma } from '@/lib/db';
import { initialiseProduction } from '@/lib/seed/core';
import { buildDemoTenant } from '@/lib/demo/build';
import { DEMO_USER_EMAIL } from '@/lib/demo/mode';

/**
 * Builds (or rebuilds) the demonstration customer on a DEMO database.
 *
 *   ALLOW_DEMO_SEED=1 npx tsx --tsconfig tsconfig.json scripts/demo-tenant.ts [--reset]
 *
 * Refuses to run against a database that holds a real customer's companies —
 * the demo lives in its own database, never beside live data. `--reset` empties
 * every table first (the nightly refresh); without it the script stops if the
 * demo already exists.
 */
async function main() {
  if (process.env.ALLOW_DEMO_SEED !== '1') {
    console.error('Refusing: set ALLOW_DEMO_SEED=1 to confirm this is a demo database.');
    process.exit(2);
  }
  const real = await prisma.company.findMany({ where: { NOT: { code: { startsWith: 'DEMO-' } } }, select: { code: true } });
  if (real.length > 0 && !process.argv.includes('--reset')) {
    console.error(`Refusing: this database already holds companies that are not demo companies (${real.map((c) => c.code).join(', ')}).`);
    process.exit(2);
  }
  if (real.length > 0) {
    console.error('Refusing even with --reset: the database holds non-demo companies. Use an empty database.');
    process.exit(2);
  }

  if (process.argv.includes('--reset')) {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    console.log('→ Emptied the demo database.');
  } else if ((await prisma.organization.count()) > 0) {
    console.error('The demo already exists. Run with --reset to rebuild it.');
    process.exit(2);
  }

  await initialiseProduction(null);
  const password = process.env.DEMO_OWNER_PASSWORD ?? 'Demo-Explore-2026!';
  const result = await buildDemoTenant({ ownerEmail: DEMO_USER_EMAIL(), ownerPassword: password });
  for (const c of result.companies) console.log(`  ${c.code.padEnd(18)} ${c.key.padEnd(13)} books reconcile: ${c.reconciled ? 'yes' : 'NO'}`);
  console.log(`\n✓ Demo ready. Sign in as ${result.ownerEmail}, or start the server with DEMO_MODE=1 for the one-click entry.`);
  if (result.companies.some((c) => !c.reconciled)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
