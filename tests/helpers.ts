import { prisma, transaction } from '@/lib/db';
import { initialiseProduction } from '@/lib/seed/core';

/**
 * Wipes every table and re-runs the bootstrap seed, so each suite starts from a
 * known, empty-but-provisioned database.
 */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  return initialiseProduction();
}

export async function getContext() {
  const dubai = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-DXB' } });
  const morocco = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-MA' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
  return { dubai, morocco, admin };
}

// A monotonic counter, not a timestamp: two calls in the same millisecond used
// to collide on the shipping-line code, which failed the suite for a reason
// that had nothing to do with the code under test.
let sequence = 0;
const unique = () => {
  sequence += 1;
  return `${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 6);
};

/** Creates the masters a coffee trading flow needs, in one call. */
export async function createMasters(companyId: string, options?: { currency?: string }) {
  const currency = options?.currency ?? 'USD';
  const suffix = unique();

  const vendor = await prisma.vendor.create({
    data: {
      companyId,
      vendorCode: `SUP-${suffix}`,
      vendorName: 'Fazenda Test Exportadora',
      country: 'Brazil',
      primaryCurrency: 'USD',
      paymentTermDays: 30,
    },
  });

  const customer = await prisma.customer.create({
    data: {
      companyId,
      customerCode: `CUS-${suffix}`,
      customerName: 'Test Roastery LLC',
      country: 'UAE',
      primaryCurrency: currency,
      paymentTermDays: 30,
    },
  });

  const item = await prisma.coffeeItem.create({
    data: {
      companyId,
      itemCode: `ITM-${suffix}`,
      itemName: 'Brazil Santos NY2 Screen 17/18',
      coffeeType: 'ARABICA',
      originCountry: 'Brazil',
      region: 'Mogiana',
      grade: 'NY2',
      screenSize: '17/18',
      process: 'NATURAL',
      cropYear: '2025/26',
      bagWeightKg: '60',
      defaultUnit: 'KG',
    },
  });

  const shippingLine = await prisma.shippingLine.create({
    data: { companyId, code: `SL-${suffix}`, name: 'Test Shipping Line' },
  });

  const warehouses = await prisma.warehouse.findMany({
    where: { companyId },
    orderBy: { code: 'asc' },
  });

  return { vendor, customer, item, shippingLine, warehouses, warehouse: warehouses[0] };
}

export async function getCashAccount(companyId: string, currency: string) {
  return prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId, currency, accountType: 'BANK' },
  });
}

export function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Convenience for tests: approve a purchase contract and immediately receive
 * all of it into one warehouse, which is the common "coffee has landed" setup.
 */
export async function receiveEverything(params: {
  companyId: string;
  purchaseContractId: string;
  warehouseId: string;
  userId: string;
  receiptDate: Date;
}) {
  const { createGoodsReceipt, postGoodsReceipt } = await import('@/lib/services/goods-receipt');
  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: params.purchaseContractId },
    orderBy: { batchNumber: 'asc' },
  });

  const grn = await createGoodsReceipt(
    {
      companyId: params.companyId,
      purchaseContractId: params.purchaseContractId,
      warehouseId: params.warehouseId,
      receiptDate: params.receiptDate,
      receivedById: params.userId,
      lines: batches.map((b) => ({
        batchId: b.id,
        quantityKg: b.orderedQuantityKg.toString(),
        bags: b.orderedBags,
      })),
    },
    params.userId,
  );

  await postGoodsReceipt({ id: grn.id, companyId: params.companyId, userId: params.userId });
  return { grn, batches };
}

export { prisma, transaction };
