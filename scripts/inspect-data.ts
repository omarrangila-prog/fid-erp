import 'dotenv/config';
import { prisma } from '@/lib/db';

/** What is actually in the database right now, table by table. */
async function main() {
  const counts = {
    companies: await prisma.company.count(),
    users: await prisma.user.count(),
    customers: await prisma.customer.count(),
    vendors: await prisma.vendor.count(),
    agents: await prisma.agent.count(),
    items: await prisma.coffeeItem.count(),
    warehouses: await prisma.warehouse.count(),
    purchaseContracts: await prisma.purchaseContract.count(),
    salesInvoices: await prisma.salesInvoice.count(),
    shipments: await prisma.shipment.count(),
    batches: await prisma.batch.count(),
    inventoryTxns: await prisma.inventoryTransaction.count(),
    receipts: await prisma.receipt.count(),
    payments: await prisma.payment.count(),
    expenses: await prisma.expense.count(),
    journalEntries: await prisma.journalEntry.count(),
    creditNotes: await prisma.creditNote.count(),
    stockCounts: await prisma.stockCount.count(),
    taxCodes: await prisma.taxCode.count(),
    auditLogs: await prisma.auditLog.count(),
  };

  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(20)} ${count}`);
  }

  console.log('\n  users:');
  for (const user of await prisma.user.findMany({ select: { name: true, email: true, isSuperAdmin: true } })) {
    console.log(`    ${user.name} <${user.email}>${user.isSuperAdmin ? ' — super admin' : ''}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
