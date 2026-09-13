/**
 * The trade the browser tests look at.
 *
 * The browser specs used to read the demo data — DEMO-PO-ETH-2601, Emirates
 * Specialty, an Ethiopian container — and when that was emptied out at the
 * client's request they began failing on data that was never theirs to
 * assume. This puts one small, named trade into each company through the
 * same services a user goes through, so a spec can say "the row for
 * E2E-PO-DXB-1 shows E2E Roastery as consignee" and mean it.
 *
 * It refuses to run against anything that does not look like a test
 * database. The browser suite runs against a server started on
 * TEST_DATABASE_URL; nothing here should ever reach the books.
 */
import { prisma } from '@/lib/db';
import { initialiseProduction } from '@/lib/seed/core';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { markShipmentLoaded } from '@/lib/services/shipment';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import { enableTax } from '@/lib/services/tax';

const url = process.env.DATABASE_URL ?? '';
const databaseName = url.replace(/\?.*$/, '').split('/').pop() ?? '';
if (!/test/i.test(databaseName)) {
  throw new Error(
    `Refusing to seed the browser fixture into "${databaseName}": DATABASE_URL must name a test database.`,
  );
}

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

type Trade = {
  companyCode: 'FID-DXB' | 'FID-MA';
  currency: string;
  rateToUsd: string;
  vendorName: string;
  customerName: string;
  itemName: string;
  origin: string;
  reference: string;
  lot: string;
  batch: string;
  container: string;
  invoiceCurrency: string;
  invoiceRate: string;
  unitPrice: string;
  receiptAmount: string;
};

async function seedTrade(trade: Trade) {
  const company = await prisma.company.findUniqueOrThrow({ where: { code: trade.companyCode } });
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
  const companyId = company.id;

  const existing = await prisma.purchaseContract.findFirst({
    where: { companyId, contractReference: trade.reference },
  });
  if (existing) {
    console.log(`${trade.companyCode}: ${trade.reference} already present`);
    return;
  }

  // Registered for tax, the way both companies are in life, so the sale below
  // carries VAT at the country's rate and the tax return has a period to show.
  if (!company.taxEnabled) {
    await enableTax({ companyId, userId: admin.id, registrationNumber: `E2E-TRN-${trade.companyCode}` });
  }

  const vendor = await prisma.vendor.create({
    data: {
      companyId,
      vendorCode: `E2E-SUP-${trade.companyCode.slice(-3)}`,
      vendorName: trade.vendorName,
      country: trade.origin,
      primaryCurrency: 'USD',
    },
  });
  const customer = await prisma.customer.create({
    data: {
      companyId,
      customerCode: `E2E-CUS-${trade.companyCode.slice(-3)}`,
      customerName: trade.customerName,
      country: company.country,
      primaryCurrency: trade.invoiceCurrency,
    },
  });
  const item = await prisma.coffeeItem.create({
    data: {
      companyId,
      itemCode: `E2E-ITM-${trade.companyCode.slice(-3)}`,
      itemName: trade.itemName,
      coffeeType: 'ARABICA',
      originCountry: trade.origin,
      grade: 'G1',
      screenSize: '15+',
      process: 'WASHED',
      cropYear: '2025/26',
      bagWeightKg: '60',
      defaultUnit: 'KG',
    },
  });
  const shippingLine = await prisma.shippingLine.create({
    data: { companyId, code: `E2E-SL-${trade.companyCode.slice(-3)}`, name: 'E2E Container Line' },
  });
  const warehouse = await prisma.warehouse.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE' },
    orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
  });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractReference: trade.reference,
      contractDate: day('2026-08-01'),
      vendorId: vendor.id,
      origin: trade.origin,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: trade.rateToUsd,
      freightAmount: '0',
      containers: 1,
      lines: [
        {
          itemId: item.id,
          lotNumber: trade.lot,
          batchNumber: trade.batch,
          containerNumber: trade.container,
          quantity: '19200',
          unit: 'KG',
          unitPrice: '4.20',
          bagWeightKg: '60',
        },
      ],
    },
    admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: admin.id });

  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  await markShipmentLoaded(
    {
      companyId,
      shipmentId: shipment.id,
      loadingDate: day('2026-08-10'),
      shippingLineId: shippingLine.id,
      etaDate: day('2026-09-05'),
      containerNumbers: [trade.container],
    },
    admin.id,
  );

  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const receipt = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: warehouse.id,
      receiptDate: day('2026-09-06'),
      receivedById: admin.id,
      lines: [{ batchId: batch.id, quantityKg: '19200', bags: 320 }],
    },
    admin.id,
  );
  await postGoodsReceipt({ id: receipt.id, companyId, userId: admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: day('2026-09-08'),
      dueDate: day('2026-10-08'),
      customerId: customer.id,
      currency: trade.invoiceCurrency,
      rateToUsd: trade.invoiceRate,
      rateLocalPerUsd: trade.rateToUsd,
      lines: [
        { batchId: batch.id, warehouseId: warehouse.id, quantity: '12000', unit: 'KG', unitPrice: trade.unitPrice },
      ],
    },
    admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: admin.id });

  // Part paid, so the sheet has a payment position to show.
  const bank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId, currency: trade.invoiceCurrency, accountType: 'BANK', status: 'ACTIVE' },
  });
  const money = await createReceipt(
    {
      companyId,
      receiptDate: day('2026-09-10'),
      customerId: customer.id,
      currency: trade.invoiceCurrency,
      amount: trade.receiptAmount,
      rateToUsd: trade.invoiceRate,
      rateLocalPerUsd: trade.rateToUsd,
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: bank.id,
      allocations: [{ salesInvoiceId: invoice.id, amount: trade.receiptAmount }],
    },
    admin.id,
  );
  await postReceipt({ id: money.id, companyId, userId: admin.id });

  // Money out as well as in: part of the supplier paid, and a clearing cost
  // capitalised into the job, so the payments, expenses and profitability
  // screens have something to show.
  const usdBank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId, currency: 'USD', accountType: 'BANK', status: 'ACTIVE' },
  });
  const payment = await createPayment(
    {
      companyId,
      paymentDate: day('2026-09-11'),
      vendorId: vendor.id,
      currency: 'USD',
      amount: '50000',
      rateToUsd: '1',
      rateLocalPerUsd: trade.rateToUsd,
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: usdBank.id,
      allocations: [{ purchaseContractId: contract.id, amount: '50000' }],
    },
    admin.id,
  );
  await postPayment({ id: payment.id, companyId, userId: admin.id });

  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
    orderBy: { code: 'asc' },
  });
  const expense = await createExpense(
    {
      companyId,
      expenseDate: day('2026-09-07'),
      expenseCategoryId: category.id,
      shipmentId: shipment.id,
      currency: 'USD',
      amount: '1200',
      rateToUsd: '1',
      rateLocalPerUsd: trade.rateToUsd,
      cashBankAccountId: usdBank.id,
      description: 'Clearing and port charges',
    },
    admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: admin.id });

  await prisma.agent.create({
    data: { companyId, agentCode: `E2E-AG-${trade.companyCode.slice(-3)}`, agentName: 'E2E Clearing Agent', commissionPct: '1' },
  });

  console.log(`${trade.companyCode}: ${contract.contractNumber} (${trade.reference}) → ${invoice.invoiceNumber}, part paid`);
}

/** Empties the test database and provisions it again from the bootstrap seed. */
async function reset() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  await initialiseProduction();
  console.log(`${databaseName}: emptied and provisioned`);
}

async function main() {
  if (process.argv.includes('--reset')) await reset();
  await seedTrade({
    companyCode: 'FID-DXB',
    currency: 'AED',
    rateToUsd: '3.6725',
    vendorName: 'E2E Exporter Ethiopia',
    customerName: 'E2E Roastery Dubai',
    itemName: 'E2E Ethiopia Sidamo G1',
    origin: 'Ethiopia',
    reference: 'E2E-PO-DXB-1',
    lot: 'E2E-LOT-DXB-1',
    batch: 'E2E-B-DXB-1',
    container: 'E2EU1000001',
    invoiceCurrency: 'AED',
    invoiceRate: '3.6725',
    unitPrice: '22',
    receiptAmount: '100000',
  });
  await seedTrade({
    companyCode: 'FID-MA',
    currency: 'MAD',
    rateToUsd: '9.85',
    vendorName: 'E2E Exporter Uganda',
    customerName: 'E2E Torréfacteur Casablanca',
    itemName: 'E2E Uganda Robusta Screen 18',
    origin: 'Uganda',
    reference: 'E2E-PO-MA-1',
    lot: 'E2E-LOT-MA-1',
    batch: 'E2E-B-MA-1',
    container: 'E2EU2000001',
    invoiceCurrency: 'MAD',
    invoiceRate: '9.85',
    unitPrice: '60',
    receiptAmount: '300000',
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
