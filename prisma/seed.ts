import 'dotenv/config';
import { prisma } from '../src/lib/db';
import { initialiseProduction } from '../src/lib/seed/core';

/**
 * Initialises a real installation and nothing else.
 *
 * Permissions, roles, the two companies with their chart of accounts, cash and
 * bank accounts, warehouses and the first Super Admin — all of it idempotent,
 * so running it twice changes nothing. No sample customers, no sample coffee,
 * no invented transactions: the company's own data is the only data.
 */
async function main() {
  console.log('→ Initialising permissions, roles, companies and the first administrator…');
  const base = await initialiseProduction();

  console.log(`  permissions: ${base.permissions}`);
  console.log(`  roles:       ${base.roles}`);
  console.log(`  companies:   ${base.companies}`);
  console.log(`  admin:       ${base.admin.email} (${base.admin.created ? 'created' : 'already existed'})`);
  console.log('\n✓ Ready. Sign in and follow the setup checklist on the dashboard.');
}

main()
  .catch((error) => {
    console.error('\n✗ Initialisation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
