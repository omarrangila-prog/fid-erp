import 'dotenv/config';
import fs from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { reconcile } from '@/lib/services/reconciliation';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { toMoney } from '@/lib/money';

/**
 * The correction of Invoice 1 (YOUSUF) on 21 Sep reversed its sale at the
 * cost it was first posted at (FID-MA-JV-000065) and re-posted it at the
 * landed cost of the day (FID-MA-JV-000066). The difference is freight that
 * reached the sold coffee after the sale and was already in cost of sales —
 * charged a second time, leaving inventory short and cost of sales long by it.
 *
 * The code no longer does this (sales.ts, returnLaterCostWithTheCoffee). This
 * posts the one entry the fixed code would have posted: Dr Inventory, Cr Cost
 * of sales, for exactly the difference between the two journals.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/repair-invoice-1-edit-cost.ts          # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/repair-invoice-1-edit-cost.ts --apply
 */

const APPLY = process.argv.includes('--apply');
const REVERSAL = 'FID-MA-JV-000065';
const REPOST = 'FID-MA-JV-000066';

async function cogsOn(entryNumber: string) {
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { entryNumber },
    include: { lines: { include: { account: { select: { systemKey: true } } } } },
  });
  const cogs = entry.lines
    .filter((l) => l.account.systemKey === ACCOUNT_KEYS.COST_OF_GOODS_SOLD)
    .reduce((s, l) => s.plus(l.debitUsd).minus(l.creditUsd), toMoney(0));
  return { entry, cogs };
}

async function main() {
  const reversal = await cogsOn(REVERSAL);
  const repost = await cogsOn(REPOST);
  const difference = toMoney(repost.cogs.plus(reversal.cogs)); // reversal carries a negative cost
  const companyId = repost.entry.companyId;
  const invoiceId = repost.entry.sourceId;

  const already = await prisma.journalEntry.findFirst({ where: { companyId, sourceType: 'INVENTORY_ADJUSTMENT', sourceId: `sale-later-cost:${invoiceId}:repair` } });
  if (already) {
    console.log(`Already repaired as ${already.entryNumber}.`);
    return;
  }

  const before = await reconcile(companyId);
  const failing = before.checks.filter((c) => !c.passed);
  console.log(`${REVERSAL} gave back ${reversal.cogs.negated()}; ${REPOST} took ${repost.cogs}; difference ${difference}.`);
  console.log('Failing now:', failing.map((c) => `${c.label} (${c.differenceUsd})`).join('; ') || 'none');

  if (!APPLY) {
    console.log(`Would post Dr Inventory / Cr Cost of goods sold USD ${difference}. Dry run only.`);
    return;
  }

  fs.mkdirSync('backups', { recursive: true });
  fs.writeFileSync(`backups/repair-invoice-1-edit-cost-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ difference: difference.toString(), failing }, null, 2));

  const posted = await transaction(async (tx) => {
    const company = await getCompanyContext(tx, companyId);
    return postJournalEntry(tx, {
      companyId,
      entryDate: repost.entry.entryDate,
      description: 'Later shipment cost on FID-MA-SI-000001 returned to stock with the coffee (correction of 21 Sep)',
      sourceType: 'INVENTORY_ADJUSTMENT',
      sourceId: `sale-later-cost:${invoiceId}:repair`,
      createdById: repost.entry.createdById,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: repost.entry.lines[0].rateLocalPerUsd,
      lines: [
        { accountKey: ACCOUNT_KEYS.INVENTORY, direction: 'DEBIT', currency: 'USD', amount: difference, rateToUsd: '1', salesInvoiceId: invoiceId },
        { accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD, direction: 'CREDIT', currency: 'USD', amount: difference, rateToUsd: '1', salesInvoiceId: invoiceId },
      ],
    });
  });
  const after = await reconcile(companyId);
  console.log(`Posted ${posted.entryNumber}. Reconciliation ${after.checks.filter((c) => c.passed).length}/${after.checks.length}.`);
  for (const c of after.checks.filter((x) => !x.passed)) console.log('  still failing:', c.label, c.differenceUsd);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
