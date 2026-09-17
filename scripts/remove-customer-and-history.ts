import 'dotenv/config';
import { prisma, transaction } from '@/lib/db';
import { refreshBatchCache, refreshWarehouseBalance } from '@/lib/services/inventory';

/**
 * Removes one customer and everything raised against them.
 *
 * This is not a reversal. A reversal is right when something really happened
 * and the books must show both the event and its correction; this is for a
 * record that should never have been there — test data, a duplicate, a
 * customer entered by mistake — where the honest end state is that it is
 * simply gone.
 *
 * Whole documents and whole journal entries go together, so double entry is
 * never left half-undone: an invoice, its lines, its journal, the stock it
 * moved, the receipts against it and their journals all leave at once. Stock
 * caches are recomputed from the movement ledger afterwards, so the warehouse
 * shows what it actually holds.
 *
 *   npx tsx scripts/remove-customer-and-history.ts "NAME"            # report
 *   npx tsx scripts/remove-customer-and-history.ts "NAME" --confirm  # remove
 */

async function main() {
  const name = process.argv[2];
  const confirm = process.argv.includes('--confirm');
  if (!name) throw new Error('Name the customer to remove.');

  const customer = await prisma.customer.findFirstOrThrow({
    where: { customerName: name },
    select: { id: true, companyId: true, customerName: true, customerCode: true },
  });

  const invoices = await prisma.salesInvoice.findMany({
    where: { customerId: customer.id },
    select: { id: true, invoiceNumber: true, status: true },
  });
  const receipts = await prisma.receipt.findMany({
    where: { customerId: customer.id },
    select: { id: true, receiptNumber: true, status: true },
  });
  const sourceIds = [...invoices.map((i) => i.id), ...receipts.map((r) => r.id)];

  // The correcting journals keyed to this customer belong to them too.
  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId: customer.companyId,
      OR: [
        { sourceId: { in: sourceIds } },
        { sourceId: { contains: `:${customer.id}:` } },
        { lines: { some: { customerId: customer.id } } },
      ],
    },
    select: { id: true, entryNumber: true },
  });

  const movements = await prisma.inventoryTransaction.findMany({
    where: { referenceType: 'SALES_INVOICE', referenceId: { in: invoices.map((i) => i.id) } },
    select: { id: true, batchId: true, warehouseId: true, itemId: true },
  });

  console.log(`${customer.customerName} (${customer.customerCode})`);
  console.log(`  invoices        ${invoices.map((i) => `${i.invoiceNumber} ${i.status}`).join(', ') || '—'}`);
  console.log(`  receipts        ${receipts.map((r) => `${r.receiptNumber} ${r.status}`).join(', ') || '—'}`);
  console.log(`  journal entries ${entries.length}`);
  console.log(`  stock movements ${movements.length}`);

  if (!confirm) {
    console.log('\nReport only. Re-run with --confirm to remove.');
    return;
  }

  const touched = [...new Map(movements.map((m) => [`${m.batchId}|${m.warehouseId}`, m])).values()];

  await transaction(async (tx) => {
    // Journals first: their lines point at the documents below.
    await tx.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
    await tx.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });

    await tx.receiptAllocation.deleteMany({ where: { receiptId: { in: receipts.map((r) => r.id) } } });
    await tx.receipt.deleteMany({ where: { id: { in: receipts.map((r) => r.id) } } });

    await tx.inventoryTransaction.deleteMany({ where: { id: { in: movements.map((m) => m.id) } } });

    await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: { in: invoices.map((i) => i.id) } } });
    await tx.salesInvoice.deleteMany({ where: { id: { in: invoices.map((i) => i.id) } } });

    await tx.customer.delete({ where: { id: customer.id } });
  }, 60_000);

  // Stock caches are derived, so recompute rather than adjust.
  for (const move of touched) {
    if (!move.warehouseId) continue;
    await transaction(async (tx) => {
      await refreshWarehouseBalance(tx, {
        companyId: customer.companyId,
        batchId: move.batchId,
        warehouseId: move.warehouseId!,
        itemId: move.itemId,
      });
      await refreshBatchCache(tx, move.batchId);
    });
  }

  console.log(`\n✓ Removed ${customer.customerName} and everything raised against them.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
