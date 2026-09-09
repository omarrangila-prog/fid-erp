import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createCreditNote, postCreditNote } from '@/lib/services/credit-note';
import { createStockCount, recordCount, postStockCount } from '@/lib/services/stock-count';
import { enableTax, listTaxCodes } from '@/lib/services/tax';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * A worked example of the business, for showing the system to someone.
 *
 * Everything here goes through the same services the application uses, so the
 * demo books are real books: the trial balance balances, the control accounts
 * agree with the sub-ledgers, and cost of goods sold comes out of an actual
 * landed cost rather than being written in. A demo built by inserting rows
 * directly would look identical on screen and fall apart the moment anyone
 * opened the reconciliation report.
 *
 * Every record is marked DEMO in its code or reference, so it is obvious in a
 * list what is real and what is not, and `npm run db:clear` removes all of it.
 *
 * Run with:  npm run db:demo
 */

const DAY = 86_400_000;

/** A date this many days before today, at midnight UTC. */
function daysAgo(days: number): Date {
  const now = new Date();
  const then = new Date(now.getTime() - days * DAY);
  return new Date(Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate()));
}

function log(message: string) {
  console.log(`  ${message}`);
}

// ---------------------------------------------------------------------------
// The coffee
// ---------------------------------------------------------------------------

const ITEMS = [
  {
    itemCode: 'DEMO-ETH-YIRG',
    itemName: 'Ethiopia Yirgacheffe Grade 1 Washed',
    coffeeType: 'ARABICA' as const,
    originCountry: 'Ethiopia',
    region: 'Yirgacheffe, Gedeo',
    grade: 'Grade 1',
    screenSize: '15+',
    process: 'WASHED' as const,
    cropYear: '2025/26',
    bagWeightKg: '60',
  },
  {
    itemCode: 'DEMO-BRA-SANTOS',
    itemName: 'Brazil Santos NY2 Screen 17/18 Fine Cup',
    coffeeType: 'ARABICA' as const,
    originCountry: 'Brazil',
    region: 'Mogiana, São Paulo',
    grade: 'NY2',
    screenSize: '17/18',
    process: 'NATURAL' as const,
    cropYear: '2025/26',
    bagWeightKg: '60',
  },
  {
    itemCode: 'DEMO-COL-SUP',
    itemName: 'Colombia Supremo Screen 18 Excelso',
    coffeeType: 'ARABICA' as const,
    originCountry: 'Colombia',
    region: 'Huila',
    grade: 'Supremo',
    screenSize: '18',
    process: 'WASHED' as const,
    cropYear: '2025/26',
    bagWeightKg: '70',
  },
  {
    itemCode: 'DEMO-UGA-ROB',
    itemName: 'Uganda Robusta Screen 18 Washed',
    coffeeType: 'ROBUSTA' as const,
    originCountry: 'Uganda',
    region: 'Kasese',
    grade: 'Screen 18',
    screenSize: '18',
    process: 'WASHED' as const,
    cropYear: '2025/26',
    bagWeightKg: '60',
  },
];

const VENDORS = [
  { vendorCode: 'DEMO-SUP-001', vendorName: 'Moplaco Trading PLC', country: 'Ethiopia', primaryCurrency: 'USD', paymentTermDays: 30 },
  { vendorCode: 'DEMO-SUP-002', vendorName: 'Cooxupé Cooperativa', country: 'Brazil', primaryCurrency: 'USD', paymentTermDays: 45 },
  { vendorCode: 'DEMO-SUP-003', vendorName: 'Racafé y Cía S.A.', country: 'Colombia', primaryCurrency: 'USD', paymentTermDays: 30 },
  { vendorCode: 'DEMO-SUP-004', vendorName: 'Kyagalanyi Coffee Ltd', country: 'Uganda', primaryCurrency: 'USD', paymentTermDays: 60 },
];

const DUBAI_CUSTOMERS = [
  { customerCode: 'DEMO-CUS-001', customerName: 'Emirates Specialty Roasters LLC', country: 'United Arab Emirates', primaryCurrency: 'AED', paymentTermDays: 30 },
  { customerCode: 'DEMO-CUS-002', customerName: 'Gulf Coffee Trading FZE', country: 'United Arab Emirates', primaryCurrency: 'USD', paymentTermDays: 45 },
  { customerCode: 'DEMO-CUS-003', customerName: 'Al Marsa Café Group', country: 'Saudi Arabia', primaryCurrency: 'USD', paymentTermDays: 60 },
  { customerCode: 'DEMO-CUS-004', customerName: 'Doha Bean Company WLL', country: 'Qatar', primaryCurrency: 'USD', paymentTermDays: 30 },
];

const MOROCCO_CUSTOMERS = [
  { customerCode: 'DEMO-CUS-101', customerName: 'Torréfaction Casablanca SARL', country: 'Morocco', primaryCurrency: 'MAD', paymentTermDays: 30 },
  { customerCode: 'DEMO-CUS-102', customerName: 'Café Maghreb Distribution', country: 'Morocco', primaryCurrency: 'MAD', paymentTermDays: 45 },
  { customerCode: 'DEMO-CUS-103', customerName: 'Atlas Coffee Export SA', country: 'Morocco', primaryCurrency: 'USD', paymentTermDays: 30 },
];

const SHIPPING_LINES = [
  { code: 'DEMO-MSK', name: 'Maersk Line' },
  { code: 'DEMO-MSC', name: 'Mediterranean Shipping Company' },
  { code: 'DEMO-CMA', name: 'CMA CGM' },
];

const AGENTS = [
  { agentCode: 'DEMO-AGT-001', agentName: 'Levant Coffee Brokers', commissionPct: '1.50' },
  { agentCode: 'DEMO-AGT-002', agentName: 'Maghreb Sourcing Partners', commissionPct: '2.00' },
];

// ---------------------------------------------------------------------------

async function seedMasters(companyId: string, customers: typeof DUBAI_CUSTOMERS) {
  for (const item of ITEMS) {
    await prisma.coffeeItem.upsert({
      where: { companyId_itemCode: { companyId, itemCode: item.itemCode } },
      update: {},
      create: { companyId, ...item, defaultUnit: 'KG' },
    });
  }

  for (const vendor of VENDORS) {
    await prisma.vendor.upsert({
      where: { companyId_vendorCode: { companyId, vendorCode: vendor.vendorCode } },
      update: {},
      create: { companyId, ...vendor },
    });
  }

  for (const customer of customers) {
    await prisma.customer.upsert({
      where: { companyId_customerCode: { companyId, customerCode: customer.customerCode } },
      update: {},
      create: { companyId, ...customer },
    });
  }

  for (const line of SHIPPING_LINES) {
    await prisma.shippingLine.upsert({
      where: { companyId_code: { companyId, code: line.code } },
      update: {},
      create: { companyId, ...line },
    });
  }

  for (const agent of AGENTS) {
    await prisma.agent.upsert({
      where: { companyId_agentCode: { companyId, agentCode: agent.agentCode } },
      update: {},
      create: { companyId, ...agent },
    });
  }

  const [items, vendors, customerRows, warehouses] = await Promise.all([
    prisma.coffeeItem.findMany({ where: { companyId, itemCode: { startsWith: 'DEMO-' } }, orderBy: { itemCode: 'asc' } }),
    prisma.vendor.findMany({ where: { companyId, vendorCode: { startsWith: 'DEMO-' } }, orderBy: { vendorCode: 'asc' } }),
    prisma.customer.findMany({ where: { companyId, customerCode: { startsWith: 'DEMO-' } }, orderBy: { customerCode: 'asc' } }),
    prisma.warehouse.findMany({ where: { companyId }, orderBy: { code: 'asc' } }),
  ]);

  return { items, vendors, customers: customerRows, warehouses };
}

type Masters = Awaited<ReturnType<typeof seedMasters>>;

/**
 * One consignment, start to finish: contract approved, freight and clearing
 * capitalised into landed cost, goods received into a warehouse.
 */
async function buyAndReceive(params: {
  companyId: string;
  userId: string;
  masters: Masters;
  reference: string;
  vendorIndex: number;
  itemIndex: number;
  lotNumber: string;
  containers: Array<{ batchNumber: string; containerNumber: string; bags: number; unitPrice: string }>;
  bagWeightKg: string;
  freight: string;
  contractDaysAgo: number;
  receiveDaysAgo: number | null;
  warehouseIndex?: number;
  localRate: string;
  localCurrency: string;
  clearing?: { amount: string; daysAgo: number };
}) {
  const { masters } = params;
  const vendor = masters.vendors[params.vendorIndex];
  const item = masters.items[params.itemIndex];
  const warehouse = masters.warehouses[params.warehouseIndex ?? 0];

  const contract = await createPurchaseContract(
    {
      companyId: params.companyId,
      contractReference: params.reference,
      supplierContractNo: `${vendor.vendorCode}/${params.reference.slice(-4)}`,
      contractDate: daysAgo(params.contractDaysAgo),
      vendorId: vendor.id,
      origin: item.originCountry,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: params.localRate,
      freightAmount: params.freight,
      otherCharges: '0',
      incoterm: 'CIF',
      portOfLoading: portFor(item.originCountry),
      destination: params.localCurrency === 'AED' ? 'Jebel Ali, Dubai' : 'Casablanca',
      expectedShipmentDate: daysAgo(params.contractDaysAgo - 14),
      paymentTermDays: vendor.paymentTermDays,
      notes: 'Demonstration contract.',
      lines: params.containers.map((container) => ({
        itemId: item.id,
        lotNumber: params.lotNumber,
        batchNumber: container.batchNumber,
        containerNumber: container.containerNumber,
        containerType: 'FT20' as const,
        quantity: String(container.bags),
        unit: 'BAG' as const,
        unitPrice: container.unitPrice,
        bags: container.bags,
        bagWeightKg: params.bagWeightKg,
      })),
    },
    params.userId,
  );

  await postPurchaseContract({ id: contract.id, companyId: params.companyId, userId: params.userId });
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } });

  // Clearing and handling at the destination: a real cost of getting the
  // coffee onto the shelf, so it capitalises into the landed cost of the batch
  // rather than hitting the profit and loss on its own.
  if (params.clearing) {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: params.companyId, capitaliseByDefault: true },
      orderBy: { code: 'asc' },
    });
    const bank = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: params.companyId, currency: params.localCurrency, accountType: 'BANK' },
    });

    const expense = await createExpense(
      {
        companyId: params.companyId,
        expenseDate: daysAgo(params.clearing.daysAgo),
        expenseCategoryId: category.id,
        shipmentId: shipment.id,
        purchaseContractId: contract.id,
        currency: params.localCurrency,
        amount: params.clearing.amount,
        rateToUsd: params.localRate,
        rateLocalPerUsd: params.localRate,
        cashBankAccountId: bank.id,
        capitaliseToLandedCost: true,
        reference: `DEMO/CLR/${params.reference.slice(-4)}`,
        description: `Clearing and handling on ${params.reference}`,
      },
      params.userId,
    );
    await postExpense({ id: expense.id, companyId: params.companyId, userId: params.userId });
  }

  if (params.receiveDaysAgo === null) {
    // Still on the water — this is what makes the Stock in Transit screen and
    // the shipment board worth looking at.
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'IN_TRANSIT',
        etdDate: daysAgo(params.contractDaysAgo - 10),
        etaDate: daysAgo(-12),
        vesselName: 'MV Demo Trader',
        voyageNumber: 'DM2601',
        billOfLading: `DEMO-BL-${params.reference.slice(-4)}`,
      },
    });
    return { contract, shipment, batches: [] };
  }

  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contract.id },
    orderBy: { batchNumber: 'asc' },
  });

  const grn = await createGoodsReceipt(
    {
      companyId: params.companyId,
      purchaseContractId: contract.id,
      warehouseId: warehouse.id,
      receiptDate: daysAgo(params.receiveDaysAgo),
      receivedById: params.userId,
      reference: `DEMO/GRN/${params.reference.slice(-4)}`,
      lines: batches.map((batch) => ({
        batchId: batch.id,
        quantityKg: batch.orderedQuantityKg.toString(),
        bags: batch.orderedBags,
      })),
    },
    params.userId,
  );
  await postGoodsReceipt({ id: grn.id, companyId: params.companyId, userId: params.userId });

  await prisma.shipment.update({
    where: { id: shipment.id },
    data: {
      status: 'DELIVERED',
      etdDate: daysAgo(params.contractDaysAgo - 10),
      etaDate: daysAgo(params.receiveDaysAgo + 2),
      ataDate: daysAgo(params.receiveDaysAgo + 2),
      deliveryDate: daysAgo(params.receiveDaysAgo),
      vesselName: 'MV Demo Trader',
      voyageNumber: 'DM2601',
      billOfLading: `DEMO-BL-${params.reference.slice(-4)}`,
    },
  });

  return {
    contract,
    shipment,
    batches: await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { batchNumber: 'asc' } }),
  };
}

function portFor(origin: string): string {
  const ports: Record<string, string> = {
    Ethiopia: 'Djibouti',
    Brazil: 'Santos',
    Colombia: 'Cartagena',
    Uganda: 'Mombasa',
  };
  return ports[origin] ?? 'Unknown';
}

export async function buildDemo() {
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
  const dubai = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-DXB' } });
  const morocco = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-MA' } });

  // --- Tax, so the demo shows the whole cycle ----------------------------
  for (const [company, registration] of [
    [dubai, '100399482300003'],
    [morocco, '40218753'],
  ] as const) {
    if (!company.taxEnabled) {
      await enableTax({ companyId: company.id, userId: admin.id, registrationNumber: registration });
      log(`${company.code}: tax registration switched on`);
    }
  }

  // =======================================================================
  // Dubai
  // =======================================================================
  log('');
  log('Dubai — FID Trading L.L.C.');
  const dxb = await seedMasters(dubai.id, DUBAI_CUSTOMERS);
  log(`  masters: ${dxb.items.length} coffees, ${dxb.vendors.length} suppliers, ${dxb.customers.length} customers`);

  const dxbTax = await listTaxCodes(dubai.id, 'SALES');
  const zeroRated = dxbTax.find((code) => code.treatment === 'ZERO_RATED')!.id;
  const standard = dxbTax.find((code) => code.treatment === 'STANDARD')!.id;

  // Consignment 1: Ethiopian, landed and largely sold.
  const eth = await buyAndReceive({
    companyId: dubai.id,
    userId: admin.id,
    masters: dxb,
    reference: 'DEMO-PO-ETH-2601',
    vendorIndex: 0,
    itemIndex: 1, // DEMO-ETH-YIRG sorts second by code
    lotNumber: 'ETH/YIRG/2601',
    bagWeightKg: '60',
    containers: [
      { batchNumber: 'DEMO-B-ETH-001', containerNumber: 'MSKU7812340', bags: 320, unitPrice: '372.00' },
      { batchNumber: 'DEMO-B-ETH-002', containerNumber: 'MSKU7812341', bags: 320, unitPrice: '372.00' },
    ],
    freight: '4200',
    contractDaysAgo: 120,
    receiveDaysAgo: 78,
    localRate: '3.6725',
    localCurrency: 'AED',
    clearing: { amount: '9800', daysAgo: 76 },
  });
  log(`  ${eth.contract.contractNumber}: Ethiopia Yirgacheffe, 2 containers, received`);

  // Consignment 2: Brazilian, landed, part sold.
  const bra = await buyAndReceive({
    companyId: dubai.id,
    userId: admin.id,
    masters: dxb,
    reference: 'DEMO-PO-BRA-2602',
    vendorIndex: 1,
    itemIndex: 0, // DEMO-BRA-SANTOS
    lotNumber: 'BRA/SAN/2602',
    bagWeightKg: '60',
    containers: [
      { batchNumber: 'DEMO-B-BRA-001', containerNumber: 'MSCU4429871', bags: 300, unitPrice: '258.00' },
      { batchNumber: 'DEMO-B-BRA-002', containerNumber: 'MSCU4429872', bags: 300, unitPrice: '258.00' },
      { batchNumber: 'DEMO-B-BRA-003', containerNumber: 'MSCU4429873', bags: 300, unitPrice: '261.00' },
    ],
    freight: '5600',
    contractDaysAgo: 95,
    receiveDaysAgo: 52,
    warehouseIndex: 1,
    localRate: '3.6725',
    localCurrency: 'AED',
    clearing: { amount: '12400', daysAgo: 50 },
  });
  log(`  ${bra.contract.contractNumber}: Brazil Santos, 3 containers, received`);

  // Consignment 3: Colombian, still on the water.
  const col = await buyAndReceive({
    companyId: dubai.id,
    userId: admin.id,
    masters: dxb,
    reference: 'DEMO-PO-COL-2603',
    vendorIndex: 2,
    itemIndex: 2, // DEMO-COL-SUP
    lotNumber: 'COL/HUI/2603',
    bagWeightKg: '70',
    containers: [
      { batchNumber: 'DEMO-B-COL-001', containerNumber: 'CMAU9930211', bags: 275, unitPrice: '441.00' },
      { batchNumber: 'DEMO-B-COL-002', containerNumber: 'CMAU9930212', bags: 275, unitPrice: '441.00' },
    ],
    freight: '6100',
    contractDaysAgo: 24,
    receiveDaysAgo: null,
    localRate: '3.6725',
    localCurrency: 'AED',
  });
  log(`  ${col.contract.contractNumber}: Colombia Supremo, 2 containers, in transit`);

  // --- Sales -------------------------------------------------------------
  const aedBank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId: dubai.id, currency: 'AED', accountType: 'BANK' },
  });
  const usdBank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId: dubai.id, currency: 'USD', accountType: 'BANK' },
  });

  const dxbWarehouseA = dxb.warehouses[0];
  const dxbWarehouseB = dxb.warehouses[1];

  /**
   * A domestic sale carries VAT; an export to Saudi or Qatar is zero-rated.
   * Having both in the demo is the point — it is what the tax return screen
   * exists to separate.
   */
  const sales: Array<{
    customerIndex: number;
    batch: (typeof eth.batches)[number];
    warehouseId: string;
    bags: number;
    pricePerKg: string;
    daysAgo: number;
    currency: string;
    rateToUsd: string;
    taxCodeId: string;
    settle: 'full' | 'part' | 'none';
  }> = [
    { customerIndex: 0, batch: eth.batches[0], warehouseId: dxbWarehouseA.id, bags: 200, pricePerKg: '8.40', daysAgo: 64, currency: 'AED', rateToUsd: '3.6725', taxCodeId: standard, settle: 'full' },
    { customerIndex: 1, batch: eth.batches[0], warehouseId: dxbWarehouseA.id, bags: 90, pricePerKg: '8.55', daysAgo: 46, currency: 'USD', rateToUsd: '1', taxCodeId: standard, settle: 'part' },
    { customerIndex: 2, batch: eth.batches[1], warehouseId: dxbWarehouseA.id, bags: 250, pricePerKg: '8.30', daysAgo: 38, currency: 'USD', rateToUsd: '1', taxCodeId: zeroRated, settle: 'full' },
    { customerIndex: 3, batch: bra.batches[0], warehouseId: dxbWarehouseB.id, bags: 220, pricePerKg: '5.95', daysAgo: 30, currency: 'USD', rateToUsd: '1', taxCodeId: zeroRated, settle: 'none' },
    { customerIndex: 0, batch: bra.batches[1], warehouseId: dxbWarehouseB.id, bags: 180, pricePerKg: '6.10', daysAgo: 12, currency: 'AED', rateToUsd: '3.6725', taxCodeId: standard, settle: 'none' },
  ];

  let invoiceCount = 0;
  for (const sale of sales) {
    const customer = dxb.customers[sale.customerIndex];
    const priceInCurrency =
      sale.currency === 'AED' ? (Number(sale.pricePerKg) * 3.6725).toFixed(4) : sale.pricePerKg;

    const invoice = await createSalesInvoice(
      {
        companyId: dubai.id,
        invoiceDate: daysAgo(sale.daysAgo),
        customerId: customer.id,
        currency: sale.currency,
        rateToUsd: sale.rateToUsd,
        rateLocalPerUsd: '3.6725',
        paymentTermDays: customer.paymentTermDays,
        reference: `DEMO/SO/${1000 + invoiceCount}`,
        lines: [
          {
            batchId: sale.batch.id,
            warehouseId: sale.warehouseId,
            quantity: String(sale.bags),
            unit: 'BAG',
            unitPrice: (Number(priceInCurrency) * 60).toFixed(4),
            bags: sale.bags,
            taxCodeId: sale.taxCodeId,
          },
        ],
      },
      admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: dubai.id, userId: admin.id });
    invoiceCount += 1;

    if (sale.settle === 'none') continue;

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const share = sale.settle === 'full' ? 1 : 0.6;
    const amount = (Number(posted.totalAmount) * share).toFixed(2);

    const receipt = await createReceipt(
      {
        companyId: dubai.id,
        receiptDate: daysAgo(Math.max(1, sale.daysAgo - 20)),
        customerId: customer.id,
        currency: posted.currency,
        amount,
        rateToUsd: posted.rateToUsd.toString(),
        rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: posted.currency === 'AED' ? aedBank.id : usdBank.id,
        reference: `DEMO/TT/${2000 + invoiceCount}`,
        description: `Settlement of ${posted.invoiceNumber}`,
        allocations: [{ salesInvoiceId: invoice.id, amount }],
      },
      admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: dubai.id, userId: admin.id });
  }
  log(`  ${invoiceCount} sales invoices posted, with receipts against most of them`);

  // --- Paying the suppliers ----------------------------------------------
  for (const [contract, share] of [
    [eth.contract, 1],
    [bra.contract, 0.5],
  ] as const) {
    const posted = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id } });
    const amount = (Number(posted.totalValue) * share).toFixed(2);

    const payment = await createPayment(
      {
        companyId: dubai.id,
        paymentDate: daysAgo(40),
        vendorId: posted.vendorId,
        currency: 'USD',
        amount,
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: usdBank.id,
        paymentMethod: 'BANK_TRANSFER',
        reference: `DEMO/PAY/${posted.contractNumber.slice(-4)}`,
        description: `Payment against ${posted.contractNumber}`,
        allocations: [{ purchaseContractId: contract.id, amount }],
      },
      admin.id,
    );
    await postPayment({ id: payment.id, companyId: dubai.id, userId: admin.id });
  }
  log('  2 supplier payments posted');

  // --- Running costs ------------------------------------------------------
  const periodCategory = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId: dubai.id, capitaliseByDefault: false },
    orderBy: { code: 'asc' },
  });
  for (const [amount, days, description] of [
    ['4800', 58, 'Warehouse rent — quarter'],
    ['1350', 44, 'Bank charges and remittance fees'],
    ['2600', 27, 'Quality inspection and cupping'],
    ['920', 9, 'Courier and documentation'],
  ] as const) {
    const expense = await createExpense(
      {
        companyId: dubai.id,
        expenseDate: daysAgo(days),
        expenseCategoryId: periodCategory.id,
        currency: 'AED',
        amount,
        rateToUsd: '3.6725',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: aedBank.id,
        capitaliseToLandedCost: false,
        description,
      },
      admin.id,
    );
    await postExpense({ id: expense.id, companyId: dubai.id, userId: admin.id });
  }
  log('  4 operating expenses posted');

  // --- A quality claim ----------------------------------------------------
  // Against the most recent unpaid invoice, which is when a claim actually
  // arrives — nobody raises a quality claim on a consignment they settled
  // months ago.
  const claimInvoice = await prisma.salesInvoice.findFirstOrThrow({
    where: { companyId: dubai.id, status: 'POSTED', allocations: { none: {} } },
    orderBy: { invoiceDate: 'desc' },
    include: { lines: true },
  });
  const creditNote = await createCreditNote(
    {
      companyId: dubai.id,
      type: 'CUSTOMER',
      creditDate: daysAgo(20),
      customerId: claimInvoice.customerId,
      salesInvoiceId: claimInvoice.id,
      currency: claimInvoice.currency,
      rateToUsd: claimInvoice.rateToUsd.toString(),
      rateLocalPerUsd: '3.6725',
      reason: 'Quality claim — 15 bags below contracted cup score',
      reference: 'DEMO/CLM/0007',
      lines: [
        {
          description: '15 bags returned against cup score',
          batchId: claimInvoice.lines[0].batchId,
          warehouseId: claimInvoice.lines[0].warehouseId,
          quantityKg: '900',
          bags: 15,
          unitPrice: claimInvoice.lines[0].unitPriceKg.toString(),
          taxCodeId: standard,
        },
      ],
    },
    admin.id,
  );
  await postCreditNote({ id: creditNote.id, companyId: dubai.id, userId: admin.id });
  log(`  ${creditNote.creditNoteNumber}: quality claim, 15 bags returned to stock`);

  // --- A stock count that found a small shortage -------------------------
  const count = await createStockCount(
    { companyId: dubai.id, warehouseId: dxbWarehouseA.id, countDate: daysAgo(6), notes: 'Quarterly count, aisles A–D.' },
    admin.id,
  );
  const countLines = await prisma.stockCountLine.findMany({
    where: { stockCountId: count.id },
    orderBy: { batchId: 'asc' },
  });
  await recordCount({
    id: count.id,
    companyId: dubai.id,
    userId: admin.id,
    lines: countLines.map((line, index) => ({
      batchId: line.batchId,
      // One batch is short by 18 kg — dust and spillage over a quarter. The
      // rest agree, which is what a healthy count looks like.
      countedKg: index === 0 ? Number(line.systemKg).toFixed(3) : (Number(line.systemKg) - 18).toFixed(3),
      reason: index === 0 ? null : ('LOSS' as const),
      notes: index === 0 ? null : 'Spillage and dust over the quarter',
    })),
  });
  await postStockCount({ id: count.id, companyId: dubai.id, userId: admin.id });
  log(`  ${count.countNumber}: quarterly count posted, one batch 18 KG short`);

  // --- A couple of drafts, because a real system always has some ---------
  const draft = await createSalesInvoice(
    {
      companyId: dubai.id,
      invoiceDate: daysAgo(1),
      customerId: dxb.customers[1].id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      paymentTermDays: 45,
      reference: 'DEMO/SO/1099',
      notes: 'Awaiting the customer’s confirmation of the shipping schedule.',
      lines: [
        {
          batchId: bra.batches[2].id,
          warehouseId: dxbWarehouseB.id,
          quantity: '120',
          unit: 'BAG',
          unitPrice: (6.2 * 60).toFixed(4),
          bags: 120,
          taxCodeId: zeroRated,
        },
      ],
    },
    admin.id,
  );
  log(`  ${draft.invoiceNumber}: left as a draft, reserving stock`);

  // =======================================================================
  // Morocco
  // =======================================================================
  log('');
  log('Morocco — FID Trading International SARL');
  const ma = await seedMasters(morocco.id, MOROCCO_CUSTOMERS);
  log(`  masters: ${ma.items.length} coffees, ${ma.vendors.length} suppliers, ${ma.customers.length} customers`);

  const maTax = await listTaxCodes(morocco.id, 'SALES');
  const maStandard = maTax.find((code) => code.treatment === 'STANDARD')!.id;
  const maZero = maTax.find((code) => code.treatment === 'ZERO_RATED')!.id;

  const uga = await buyAndReceive({
    companyId: morocco.id,
    userId: admin.id,
    masters: ma,
    reference: 'DEMO-PO-UGA-2604',
    vendorIndex: 3,
    itemIndex: 3, // DEMO-UGA-ROB
    lotNumber: 'UGA/KAS/2604',
    bagWeightKg: '60',
    containers: [
      { batchNumber: 'DEMO-B-UGA-001', containerNumber: 'MSKU5540991', bags: 330, unitPrice: '168.00' },
      { batchNumber: 'DEMO-B-UGA-002', containerNumber: 'MSKU5540992', bags: 330, unitPrice: '168.00' },
    ],
    freight: '3900',
    contractDaysAgo: 88,
    receiveDaysAgo: 44,
    localRate: '9.85',
    localCurrency: 'MAD',
    clearing: { amount: '31000', daysAgo: 42 },
  });
  log(`  ${uga.contract.contractNumber}: Uganda Robusta, 2 containers, received`);

  const braMa = await buyAndReceive({
    companyId: morocco.id,
    userId: admin.id,
    masters: ma,
    reference: 'DEMO-PO-BRA-2605',
    vendorIndex: 1,
    itemIndex: 0,
    lotNumber: 'BRA/SAN/2605',
    bagWeightKg: '60',
    containers: [{ batchNumber: 'DEMO-B-BRA-101', containerNumber: 'MSCU8817330', bags: 300, unitPrice: '256.00' }],
    freight: '2100',
    contractDaysAgo: 35,
    receiveDaysAgo: null,
    localRate: '9.85',
    localCurrency: 'MAD',
  });
  log(`  ${braMa.contract.contractNumber}: Brazil Santos, 1 container, in transit`);

  const madBank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId: morocco.id, currency: 'MAD', accountType: 'BANK' },
  });
  const maUsdBank = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId: morocco.id, currency: 'USD', accountType: 'BANK' },
  });

  const maSales = [
    { customerIndex: 0, batchIndex: 0, bags: 220, pricePerKg: '3.95', daysAgo: 36, currency: 'MAD', rateToUsd: '9.85', taxCodeId: maStandard, settle: 'full' as const },
    { customerIndex: 1, batchIndex: 0, bags: 100, pricePerKg: '4.05', daysAgo: 22, currency: 'MAD', rateToUsd: '9.85', taxCodeId: maStandard, settle: 'part' as const },
    { customerIndex: 2, batchIndex: 1, bags: 260, pricePerKg: '3.88', daysAgo: 15, currency: 'USD', rateToUsd: '1', taxCodeId: maZero, settle: 'none' as const },
  ];

  let maInvoices = 0;
  for (const sale of maSales) {
    const customer = ma.customers[sale.customerIndex];
    const priceInCurrency =
      sale.currency === 'MAD' ? (Number(sale.pricePerKg) * 9.85).toFixed(4) : sale.pricePerKg;

    const invoice = await createSalesInvoice(
      {
        companyId: morocco.id,
        invoiceDate: daysAgo(sale.daysAgo),
        customerId: customer.id,
        currency: sale.currency,
        rateToUsd: sale.rateToUsd,
        rateLocalPerUsd: '9.85',
        paymentTermDays: customer.paymentTermDays,
        reference: `DEMO/SO/${3000 + maInvoices}`,
        lines: [
          {
            batchId: uga.batches[sale.batchIndex].id,
            warehouseId: ma.warehouses[0].id,
            quantity: String(sale.bags),
            unit: 'BAG',
            unitPrice: (Number(priceInCurrency) * 60).toFixed(4),
            bags: sale.bags,
            taxCodeId: sale.taxCodeId,
          },
        ],
      },
      admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: morocco.id, userId: admin.id });
    maInvoices += 1;

    if (sale.settle === 'none') continue;
    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const amount = (Number(posted.totalAmount) * (sale.settle === 'full' ? 1 : 0.55)).toFixed(2);

    const receipt = await createReceipt(
      {
        companyId: morocco.id,
        receiptDate: daysAgo(Math.max(1, sale.daysAgo - 15)),
        customerId: customer.id,
        currency: posted.currency,
        amount,
        rateToUsd: posted.rateToUsd.toString(),
        rateLocalPerUsd: '9.85',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: posted.currency === 'MAD' ? madBank.id : maUsdBank.id,
        reference: `DEMO/TT/${4000 + maInvoices}`,
        allocations: [{ salesInvoiceId: invoice.id, amount }],
      },
      admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: morocco.id, userId: admin.id });
  }
  log(`  ${maInvoices} sales invoices posted, with receipts against two of them`);

  const maPosted = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: uga.contract.id } });
  const maPayment = await createPayment(
    {
      companyId: morocco.id,
      paymentDate: daysAgo(30),
      vendorId: maPosted.vendorId,
      currency: 'USD',
      amount: (Number(maPosted.totalValue) * 0.7).toFixed(2),
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      cashBankAccountId: maUsdBank.id,
      paymentMethod: 'BANK_TRANSFER',
      reference: `DEMO/PAY/${maPosted.contractNumber.slice(-4)}`,
      allocations: [{ purchaseContractId: uga.contract.id, amount: (Number(maPosted.totalValue) * 0.7).toFixed(2) }],
    },
    admin.id,
  );
  await postPayment({ id: maPayment.id, companyId: morocco.id, userId: admin.id });

  const maPeriodCategory = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId: morocco.id, capitaliseByDefault: false },
    orderBy: { code: 'asc' },
  });
  for (const [amount, days, description] of [
    ['18500', 40, 'Entrepôt Casablanca — loyer trimestriel'],
    ['4200', 18, 'Frais bancaires'],
  ] as const) {
    const expense = await createExpense(
      {
        companyId: morocco.id,
        expenseDate: daysAgo(days),
        expenseCategoryId: maPeriodCategory.id,
        currency: 'MAD',
        amount,
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        cashBankAccountId: madBank.id,
        capitaliseToLandedCost: false,
        description,
      },
      admin.id,
    );
    await postExpense({ id: expense.id, companyId: morocco.id, userId: admin.id });
  }
  log('  1 supplier payment and 2 operating expenses posted');

  // =======================================================================
  // The point of building it through the services
  // =======================================================================
  log('');
  for (const company of [dubai, morocco]) {
    const result = await reconcile(company.id);
    const passed = result.checks.filter((check) => check.passed).length;
    const failures = result.checks.filter((check) => !check.passed);
    log(`${company.code}: ${passed}/${result.checks.length} reconciliation checks pass`);
    for (const failure of failures) {
      log(`    FAILED — ${failure.label}: ${failure.differenceUsd}`);
    }
  }
}

async function main() {
  console.log('\n→ Building demonstration data…\n');
  await buildDemo();
  console.log('\n✓ Done. Every record is marked DEMO; `npm run db:clear` removes all of it.\n');
}

main()
  .catch((error) => {
    console.error('\n✗ Demo data failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
