import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { postJournalEntry } from '@/lib/services/accounting';
import { writeAudit } from '@/lib/services/audit';
import { getCompanyContext } from '@/lib/services/company';

/**
 * Put back the cost of sales that no invoice ever carried.
 *
 * A late shipment charge used to be trued up into cost of sales using the
 * batch's own sold quantity, while the restatement was written onto the sales
 * invoices. Where those two disagreed the ledger moved more into cost of sales
 * than any document absorbed, and the difference has sat there ever since:
 * cost of sales too high, inventory too low, by the same amount. The engine no
 * longer does this (the true-up is sized from the documents themselves); this
 * corrects what is already in the books.
 *
 * It posts one dated correction — debit Inventory, credit Cost of Goods Sold —
 * for exactly the difference between the ledger and the documents. Nothing is
 * deleted, no historical entry is touched, and the amount is derived, never
 * typed.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/repair-cogs-drift.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/repair-cogs-drift.ts --apply   # write
 */
const apply = process.argv.includes('--apply');

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, code: true, name: true } });
  const backup: unknown[] = [];

  for (const company of companies) {
    const cogs = await prisma.account.findFirst({
      where: { companyId: company.id, systemKey: 'COST_OF_GOODS_SOLD' },
      select: { id: true, name: true },
    });
    const inventory = await prisma.account.findFirst({
      where: { companyId: company.id, systemKey: 'INVENTORY' },
      select: { id: true, name: true },
    });
    if (!cogs || !inventory) continue;

    // What the ledger says cost of sales is.
    const ledger = await prisma.journalLine.aggregate({
      where: { accountId: cogs.id, journalEntry: { status: 'POSTED' } },
      _sum: { debitUsd: true, creditUsd: true },
    });
    const ledgerCogs = toMoney(dec(ledger._sum.debitUsd ?? 0).minus(dec(ledger._sum.creditUsd ?? 0)));

    // What the documents say it is.
    const [invoices, notes] = await Promise.all([
      prisma.salesInvoice.aggregate({
        where: { companyId: company.id, status: 'POSTED' },
        _sum: { costOfGoodsUsd: true },
      }),
      prisma.creditNote.aggregate({
        where: { companyId: company.id, status: 'POSTED', type: 'CUSTOMER' },
        _sum: { costOfGoodsUsd: true },
      }),
    ]);
    const documentCogs = toMoney(
      dec(invoices._sum.costOfGoodsUsd ?? 0).minus(dec(notes._sum.costOfGoodsUsd ?? 0)),
    );

    const drift = toMoney(ledgerCogs.minus(documentCogs));
    console.log(
      `${company.code}: ledger cost of sales ${ledgerCogs.toFixed(2)}, documents ${documentCogs.toFixed(2)}, difference ${drift.toFixed(2)}`,
    );
    if (drift.abs().lessThan('0.005')) {
      console.log('  nothing to correct');
      continue;
    }

    backup.push({ company: company.code, ledgerCogs: ledgerCogs.toString(), documentCogs: documentCogs.toString(), drift: drift.toString() });
    const up = drift.greaterThan(0);
    console.log(
      `  ${up ? 'debit' : 'credit'} ${inventory.name} ${drift.abs().toFixed(2)} · ${up ? 'credit' : 'debit'} ${cogs.name} ${drift.abs().toFixed(2)}`,
    );

    if (!apply) continue;

    const context = await transaction((tx) => getCompanyContext(tx, company.id));
    const actor = await prisma.user.findFirstOrThrow({ select: { id: true } });
    await transaction(async (tx) => {
      await postJournalEntry(tx, {
        companyId: company.id,
        entryDate: new Date(),
        description:
          'Correction: cost of sales restated to the sales documents. A late shipment charge had been trued up beyond what the invoices carried.',
        sourceType: 'INVENTORY_ADJUSTMENT',
        sourceId: `cogs-drift-${company.id}`,
        createdById: actor.id,
        localCurrency: context.localCurrency,
        rateLocalPerUsd: 1,
        lines: [
          {
            accountId: up ? inventory.id : cogs.id,
            direction: 'DEBIT',
            currency: 'USD',
            amount: drift.abs(),
            rateToUsd: 1,
            description: 'Cost of sales restated to the sales documents',
          },
          {
            accountId: up ? cogs.id : inventory.id,
            direction: 'CREDIT',
            currency: 'USD',
            amount: drift.abs(),
            rateToUsd: 1,
            description: 'Cost of sales restated to the sales documents',
          },
        ],
      });
      await writeAudit(tx, {
        companyId: company.id,
        userId: actor.id,
        action: 'COGS_DRIFT_CORRECTED',
        entityType: 'Company',
        entityId: company.id,
        before: { ledgerCogs: ledgerCogs.toString() },
        after: { documentCogs: documentCogs.toString(), correction: drift.toString() },
      });
    });
    console.log('  corrected');
  }

  if (apply && backup.length > 0) {
    mkdirSync(`${process.cwd()}/backups`, { recursive: true });
    const path = `${process.cwd()}/backups/cogs-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(backup, null, 2));
    console.log(`\nbefore/after written to ${path}`);
  }
  if (!apply) console.log('\ndry run — pass --apply to write');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
