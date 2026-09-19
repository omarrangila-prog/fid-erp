import 'dotenv/config';
import { prisma } from '@/lib/db';
import { reversedReference } from '@/lib/services/purchase';

/**
 * Give a reversed order's reference back to the trade.
 *
 * An order reversed before this rule kept its reference, so a new order for
 * the same trade was refused as "already used". This renames every reversed
 * order's reference to its marked-up form — "ICUL/FID/002 (reversed …)" —
 * exactly as a reversal does now. Nothing else on the record changes.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/free-reversed-references.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/free-reversed-references.ts --apply   # write
 */
const apply = process.argv.includes('--apply');

async function main() {
  const reversed = await prisma.purchaseContract.findMany({
    where: { status: 'REVERSED', NOT: { contractReference: { contains: '(reversed ' } } },
    select: { id: true, contractNumber: true, contractReference: true, reversedAt: true, company: { select: { code: true } } },
  });
  console.log(`${reversed.length} reversed ${reversed.length === 1 ? 'order' : 'orders'} still holding a reference`);
  for (const r of reversed) {
    console.log(`  ${r.company.code}  ${r.contractReference}  →  ${reversedReference(r.contractReference, r.reversedAt ?? new Date())}`);
  }
  if (!apply) {
    console.log('dry run — pass --apply to write');
    return;
  }
  for (const r of reversed) {
    await prisma.purchaseContract.update({
      where: { id: r.id },
      data: { contractReference: reversedReference(r.contractReference, r.reversedAt ?? new Date()) },
    });
  }
  console.log(`renamed ${reversed.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
