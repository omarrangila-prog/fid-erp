import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';
import { updateExpense } from '@/lib/services/expense';
import { dec, sum } from '@/lib/money';

/**
 * Re-cost the posted shipment expenses to share equally per container.
 *
 * They were booked when a shared cost was split equally between the coffees
 * on the order and then by weight inside each coffee, so a coffee that
 * arrived in one container bore the same charge as one that arrived in three.
 * The client's rule is that the work is done per box: each container takes one
 * share, and a coffee's charge is the sum of its own containers'.
 *
 * How it works: each expense is put back through `updateExpense` with its own
 * values and the new method. Changing the method is a change to the posting,
 * so the service unwinds the original postings and reposts them — the same
 * path the Edit screen uses, with the same audit trail, inside one
 * transaction per expense. Nothing is hand-edited, no journal is deleted, and
 * cost of sales is restated by the engine where coffee has been sold.
 *
 * It refuses an expense a payment has settled; the service does, and rightly
 * — the payment would be relieving a cost that no longer exists as booked.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/recost-per-container.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/recost-per-container.ts --apply   # write
 */
const apply = process.argv.includes('--apply');

type Snapshot = {
  batchNumber: string;
  itemName: string;
  containerNumber: string | null;
  capitalisedUsd: string;
};

async function batchState(companyId: string): Promise<Snapshot[]> {
  const rows = await prisma.batch.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: {
      batchNumber: true,
      capitalisedCostUsd: true,
      item: { select: { itemName: true } },
      container: { select: { containerNumber: true } },
    },
    orderBy: { batchNumber: 'asc' },
  });
  return rows.map((b) => ({
    batchNumber: b.batchNumber,
    itemName: b.item.itemName,
    containerNumber: b.container?.containerNumber ?? null,
    capitalisedUsd: dec(b.capitalisedCostUsd).toFixed(4),
  }));
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, code: true, name: true } });

  for (const company of companies) {
    const expenses = await prisma.expense.findMany({
      where: {
        companyId: company.id,
        status: 'POSTED',
        capitaliseToLandedCost: true,
        shipmentId: { not: null },
        allocationMethod: { not: 'PER_CONTAINER' },
      },
      orderBy: { expenseNumber: 'asc' },
    });
    if (expenses.length === 0) continue;

    console.log(`\n${company.code} — ${company.name}`);
    console.log(`  ${expenses.length} posted shipment cost(s) to re-cost\n`);

    // What the books say before anything is touched.
    const before = await batchState(company.id);
    const beforeTotal = sum(before.map((b) => dec(b.capitalisedUsd)));
    const counts = {
      expenses: await prisma.expense.count({ where: { companyId: company.id } }),
      journalEntries: await prisma.journalEntry.count({ where: { companyId: company.id } }),
      batches: await prisma.batch.count({ where: { companyId: company.id } }),
    };
    console.log(`  rows: ${counts.expenses} expenses, ${counts.journalEntries} journals, ${counts.batches} batches`);
    console.log(`  capitalised on batches: USD ${beforeTotal.toFixed(2)}\n`);

    // Which ones a payment has settled: the service will refuse these.
    const blocked: string[] = [];
    for (const e of expenses) {
      const settled = await prisma.paymentAllocation.count({
        where: { expenseId: e.id, payment: { status: 'POSTED' } },
      });
      if (settled > 0) blocked.push(e.expenseNumber);
    }
    if (blocked.length) {
      console.log(`  settled by a payment, so left as they are: ${blocked.join(', ')}\n`);
    }

    if (!apply) {
      for (const e of expenses) {
        const mark = blocked.includes(e.expenseNumber) ? 'skip' : 'would re-cost';
        console.log(`    ${mark.padEnd(13)} ${e.expenseNumber}  ${e.currency} ${dec(e.amount).toFixed(2)}  (${e.allocationMethod})`);
      }
      continue;
    }

    let done = 0;
    const failures: Array<{ expense: string; error: string }> = [];
    for (const e of expenses) {
      if (blocked.includes(e.expenseNumber)) continue;
      try {
        // Its own values, with the share moved to the container. The service
        // unwinds and reposts, restating cost of sales where coffee has sold.
        await updateExpense(
          e.id,
          {
            companyId: company.id,
            expenseDate: e.expenseDate,
            expenseCategoryId: e.expenseCategoryId,
            shipmentId: e.shipmentId,
            purchaseContractId: e.purchaseContractId,
            containerId: e.containerId,
            batchId: e.batchId,
            vendorId: e.vendorId,
            agentId: e.agentId,
            payableToAgentId: e.payableToAgentId,
            currency: e.currency,
            amount: e.amount.toString(),
            rateToUsd: e.rateToUsd.toString(),
            rateLocalPerUsd: e.rateLocalPerUsd.toString(),
            cashBankAccountId: e.cashBankAccountId,
            ledgerAccountId: e.ledgerAccountId,
            ledgerAgentId: e.ledgerAgentId,
            paymentMethod: e.paymentMethod,
            capitaliseToLandedCost: e.capitaliseToLandedCost,
            allocationMethod: 'PER_CONTAINER',
            taxCodeId: e.taxCodeId,
            reference: e.reference,
            description: e.description,
          } as never,
          // Attributed to the account that created it, so the audit trail
          // names a real person rather than a script.
          e.createdById,
        );
        done += 1;
        console.log(`    ✓ ${e.expenseNumber}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ expense: e.expenseNumber, error: message });
        console.log(`    ✗ ${e.expenseNumber} — ${message}`);
      }
    }

    const after = await batchState(company.id);
    const afterTotal = sum(after.map((b) => dec(b.capitalisedUsd)));
    const countsAfter = {
      expenses: await prisma.expense.count({ where: { companyId: company.id } }),
      journalEntries: await prisma.journalEntry.count({ where: { companyId: company.id } }),
      batches: await prisma.batch.count({ where: { companyId: company.id } }),
    };

    console.log(`\n  re-costed ${done}, failed ${failures.length}, skipped ${blocked.length}`);
    console.log(`  rows now: ${countsAfter.expenses} expenses, ${countsAfter.journalEntries} journals, ${countsAfter.batches} batches`);
    console.log(`    (expenses ${countsAfter.expenses - counts.expenses >= 0 ? '+' : ''}${countsAfter.expenses - counts.expenses},` +
                ` journals +${countsAfter.journalEntries - counts.journalEntries},` +
                ` batches ${countsAfter.batches - counts.batches >= 0 ? '+' : ''}${countsAfter.batches - counts.batches})`);
    console.log(`  capitalised on batches: USD ${afterTotal.toFixed(2)} (was ${beforeTotal.toFixed(2)})`);
    console.log(`  difference: USD ${afterTotal.minus(beforeTotal).toFixed(2)} — should be 0.00, the cost only moved\n`);

    console.log('  what each container carries now:');
    const byBatch = new Map(before.map((b) => [b.batchNumber, b]));
    for (const row of after) {
      const was = byBatch.get(row.batchNumber);
      const change = was ? dec(row.capitalisedUsd).minus(dec(was.capitalisedUsd)) : dec(0);
      const arrow = change.isZero() ? '  =' : change.greaterThan(0) ? ' up' : 'down';
      console.log(
        `    ${row.batchNumber.padEnd(14)} ${(row.containerNumber ?? '—').padEnd(14)} ${row.itemName.slice(0, 26).padEnd(26)}` +
          ` ${dec(was?.capitalisedUsd ?? 0).toFixed(2).padStart(12)} → ${dec(row.capitalisedUsd).toFixed(2).padStart(12)} ${arrow} ${change.abs().toFixed(2)}`,
      );
    }

    mkdirSync('backups', { recursive: true });
    const file = `backups/recost-per-container-${company.code}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(
      file,
      JSON.stringify({ ranAt: new Date().toISOString(), company: company.code, counts, before, after, blocked, failures }, null, 2),
    );
    console.log(`\n  before and after written to ${file}`);
    if (failures.length) process.exitCode = 1;
  }

  if (!apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}

main().finally(() => prisma.$disconnect());
