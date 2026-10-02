import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  Decimal,
  dec,
  toMoney,
  toQuantity,
  toUnitCost,
  percentage,
  allocateProportionally,
  convertToLocal,
  convertToUsd,
  convertFromUsd,
} from '@/lib/money';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { getReceivables } from '@/lib/services/receivables';
import { getNumberSetting, SETTING_KEYS } from '@/lib/services/settings';

/**
 * Stock, sales and profit by coffee — the Stock on Hand item view.
 *
 * Nothing here is a new ledger. Every figure is read from a record another
 * screen already shows, the same way that screen reads it:
 *
 *   Received, transfers, sold, on hand   the stock movement ledger (inventory_transactions),
 *                                        per batch and warehouse — what Current Stock reads
 *   Landed cost per KG, stock value      getBatchCostings — what Shipment Costing reads
 *   Sales revenue                        posted invoice lines, less customer credit notes —
 *                                        each line once, never the invoice header or its journal
 *   Cost of goods sold                   in USD the cost posted on each invoice line (true-ups
 *                                        included, as posted); in the company's currency the
 *                                        KG sold at the batch's landed cost in that currency —
 *                                        Shipment Profitability's figure
 *   Collected / outstanding              receipts and credit notes allocated to the invoice,
 *                                        as Outstanding Invoices counts them
 *
 * Where a payment is known only against the whole invoice, it is shared over
 * the invoice's lines in proportion to each line's value (VAT included, as the
 * customer owes it). That is the one method used here and on the item page.
 *
 * Every figure is kept in the company's currency with its USD equivalent,
 * each transaction at its own rate. Decimal throughout; no floats.
 */

export type Pair = { local: Decimal; usd: Decimal };

export const COLLECTION_METHODS = ['CASH', 'BANK', 'CHEQUE', 'AGENT', 'LEDGER'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];
export const COLLECTION_LABELS: Record<CollectionMethod, string> = {
  CASH: 'Cash',
  BANK: 'Bank',
  CHEQUE: 'Cheque',
  AGENT: 'Agent collection',
  LEDGER: 'Settled through a ledger',
};

/** Receipt payment methods, in the words the item page uses. */
function methodOf(paymentMethod: string): CollectionMethod {
  switch (paymentMethod) {
    case 'CASH':
      return 'CASH';
    case 'BANK_TRANSFER':
      return 'BANK';
    case 'CHEQUE':
      return 'CHEQUE';
    case 'AGENT_COLLECTION':
      return 'AGENT';
    default:
      return 'LEDGER';
  }
}

export type ItemProfitFilters = {
  companyId: string;
  itemId?: string;
  warehouseId?: string;
  shipmentId?: string;
  batchId?: string;
  containerId?: string;
  /** Sales, receipts and movements from this date; stock before it is the opening. */
  from?: Date;
  /** Everything up to and including this date. */
  to?: Date;
  /** The warehouses this person may see, or null for every one. */
  warehouseIds?: string[] | null;
};

export type ItemMeasures = {
  /** Stock before the period, when a start date is set. */
  openingKg: Decimal;
  /** Goods receipts (and opening stock) into the warehouse. */
  receivedKg: Decimal;
  transferInKg: Decimal;
  transferOutKg: Decimal;
  /** Sold per the stock ledger: invoice movements less returns. */
  stockSoldKg: Decimal;
  /** Stock counts and write-offs, net. */
  adjustmentKg: Decimal;
  onHandKg: Decimal;
  /** Held for draft sales and approved transfers. */
  reservedKg: Decimal;
  availableKg: Decimal;
  /** Sold per the invoice lines, less coffee returned on credit notes. */
  soldKg: Decimal;
  revenue: Pair;
  cogs: Pair;
  grossProfit: Pair;
  /** What the invoices ask the customer for — the line value with its VAT. */
  invoiced: Pair;
  collected: Record<CollectionMethod, Pair>;
  collectedTotal: Pair;
  /** Credit notes against the invoices: no money, but no longer owed. */
  credited: Pair;
  outstanding: Pair;
  /** On hand at its landed cost — never at a selling price. */
  stockValue: Pair;
  /** Weighted: every KG that came in at its own batch's landed cost. */
  avgCostPerKg: Pair | null;
  /** Revenue over KG sold — never an average of rates. */
  avgSellPerKg: Pair | null;
  marginPct: Decimal | null;
  profitPerKg: Pair | null;
  invoiceCount: number;
};

export type WarehouseNode = ItemMeasures & { warehouseId: string; warehouseName: string };
export type BatchNode = ItemMeasures & {
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  landedPerKg: Pair;
  warehouses: WarehouseNode[];
};
export type ContainerNode = ItemMeasures & { containerKey: string; containerNumber: string | null; batches: BatchNode[] };
export type ShipmentNode = ItemMeasures & {
  shipmentId: string;
  shipmentLabel: string;
  reference: string;
  jobNumber: string;
  containers: ContainerNode[];
};
export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'SOLD_OUT';
export type ItemNode = ItemMeasures & {
  itemId: string;
  itemName: string;
  itemCode: string;
  origin: string;
  status: StockStatus;
  warehouses: WarehouseNode[];
  shipments: ShipmentNode[];
};

export type ItemSaleLine = {
  lineId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerId: string;
  customerName: string;
  itemId: string;
  batchId: string;
  batchNumber: string;
  containerNumber: string | null;
  shipmentId: string;
  shipmentLabel: string;
  reference: string;
  warehouseId: string;
  warehouseName: string;
  quantityKg: Decimal;
  currency: string;
  /** The invoice's own price per KG, in the invoice's currency. */
  ratePerKg: Decimal;
  amount: Pair;
  cogs: Pair;
  profit: Pair;
  gross: Pair;
  collected: Record<CollectionMethod, Pair>;
  collectedTotal: Pair;
  credited: Pair;
  outstanding: Pair;
  invoiceTotal: Pair;
  invoicePaid: Pair;
  invoiceOutstanding: Pair;
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
  /** The invoice sells other coffee too, so its payment was shared by line value. */
  shared: boolean;
};

export type ItemProfitReport = {
  localCurrency: string;
  lowStockPercent: number;
  items: ItemNode[];
  total: ItemMeasures;
  lines: ItemSaleLine[];
};

// --- Accumulation -----------------------------------------------------------

type Acc = {
  openingKg: Decimal;
  receivedKg: Decimal;
  transferInKg: Decimal;
  transferOutKg: Decimal;
  stockSoldKg: Decimal;
  adjustmentKg: Decimal;
  onHandKg: Decimal;
  reservedKg: Decimal;
  soldKg: Decimal;
  revenue: Pair;
  cogs: Pair;
  invoiced: Pair;
  collected: Record<CollectionMethod, Pair>;
  credited: Pair;
  outstanding: Pair;
  stockValue: Pair;
  /** Landed cost of what was received, and the KG — the company-level average. */
  receivedBasis: { kg: Decimal; value: Pair };
  /** The same including transfers in — a warehouse's own average. */
  inflowBasis: { kg: Decimal; value: Pair };
  invoices: Set<string>;
};

const zeroPair = (): Pair => ({ local: new Decimal(0), usd: new Decimal(0) });
const addPair = (a: Pair, b: Pair): Pair => ({ local: a.local.plus(b.local), usd: a.usd.plus(b.usd) });
const subPair = (a: Pair, b: Pair): Pair => ({ local: a.local.minus(b.local), usd: a.usd.minus(b.usd) });
const moneyPair = (p: Pair): Pair => ({ local: toMoney(p.local), usd: toMoney(p.usd) });
const zeroMethods = (): Record<CollectionMethod, Pair> =>
  Object.fromEntries(COLLECTION_METHODS.map((m) => [m, zeroPair()])) as Record<CollectionMethod, Pair>;

function emptyAcc(): Acc {
  return {
    openingKg: new Decimal(0),
    receivedKg: new Decimal(0),
    transferInKg: new Decimal(0),
    transferOutKg: new Decimal(0),
    stockSoldKg: new Decimal(0),
    adjustmentKg: new Decimal(0),
    onHandKg: new Decimal(0),
    reservedKg: new Decimal(0),
    soldKg: new Decimal(0),
    revenue: zeroPair(),
    cogs: zeroPair(),
    invoiced: zeroPair(),
    collected: zeroMethods(),
    credited: zeroPair(),
    outstanding: zeroPair(),
    stockValue: zeroPair(),
    receivedBasis: { kg: new Decimal(0), value: zeroPair() },
    inflowBasis: { kg: new Decimal(0), value: zeroPair() },
    invoices: new Set(),
  };
}

function addInto(target: Acc, cell: Acc) {
  target.openingKg = target.openingKg.plus(cell.openingKg);
  target.receivedKg = target.receivedKg.plus(cell.receivedKg);
  target.transferInKg = target.transferInKg.plus(cell.transferInKg);
  target.transferOutKg = target.transferOutKg.plus(cell.transferOutKg);
  target.stockSoldKg = target.stockSoldKg.plus(cell.stockSoldKg);
  target.adjustmentKg = target.adjustmentKg.plus(cell.adjustmentKg);
  target.onHandKg = target.onHandKg.plus(cell.onHandKg);
  target.reservedKg = target.reservedKg.plus(cell.reservedKg);
  target.soldKg = target.soldKg.plus(cell.soldKg);
  target.revenue = addPair(target.revenue, cell.revenue);
  target.cogs = addPair(target.cogs, cell.cogs);
  target.invoiced = addPair(target.invoiced, cell.invoiced);
  for (const m of COLLECTION_METHODS) target.collected[m] = addPair(target.collected[m], cell.collected[m]);
  target.credited = addPair(target.credited, cell.credited);
  target.outstanding = addPair(target.outstanding, cell.outstanding);
  target.stockValue = addPair(target.stockValue, cell.stockValue);
  target.receivedBasis = {
    kg: target.receivedBasis.kg.plus(cell.receivedBasis.kg),
    value: addPair(target.receivedBasis.value, cell.receivedBasis.value),
  };
  target.inflowBasis = {
    kg: target.inflowBasis.kg.plus(cell.inflowBasis.kg),
    value: addPair(target.inflowBasis.value, cell.inflowBasis.value),
  };
  for (const id of cell.invoices) target.invoices.add(id);
}

const perKg = (value: Pair, kg: Decimal): Pair | null =>
  kg.greaterThan(0) ? { local: toUnitCost(value.local.dividedBy(kg)), usd: toUnitCost(value.usd.dividedBy(kg)) } : null;

/**
 * The finished figures for one node. A warehouse's average cost counts the
 * coffee transferred into it; the company's counts each KG once, where it was
 * received, so a transfer never weighs a container twice.
 */
function measure(acc: Acc, basis: 'received' | 'inflow'): ItemMeasures {
  const revenue = moneyPair(acc.revenue);
  const cogs = moneyPair(acc.cogs);
  const grossProfit = moneyPair(subPair(revenue, cogs));
  const collected = Object.fromEntries(COLLECTION_METHODS.map((m) => [m, moneyPair(acc.collected[m])])) as Record<CollectionMethod, Pair>;
  const collectedTotal = moneyPair(COLLECTION_METHODS.reduce((sum, m) => addPair(sum, collected[m]), zeroPair()));
  const soldKg = toQuantity(acc.soldKg);
  const onHandKg = toQuantity(acc.onHandKg);
  const reservedKg = toQuantity(acc.reservedKg);
  const costBasis = basis === 'inflow' ? acc.inflowBasis : acc.receivedBasis;
  return {
    openingKg: toQuantity(acc.openingKg),
    receivedKg: toQuantity(acc.receivedKg),
    transferInKg: toQuantity(acc.transferInKg),
    transferOutKg: toQuantity(acc.transferOutKg),
    stockSoldKg: toQuantity(acc.stockSoldKg),
    adjustmentKg: toQuantity(acc.adjustmentKg),
    onHandKg,
    reservedKg,
    availableKg: toQuantity(onHandKg.minus(reservedKg)),
    soldKg,
    revenue,
    cogs,
    grossProfit,
    invoiced: moneyPair(acc.invoiced),
    collected,
    collectedTotal,
    credited: moneyPair(acc.credited),
    outstanding: moneyPair(acc.outstanding),
    stockValue: moneyPair(acc.stockValue),
    avgCostPerKg: perKg(costBasis.value, costBasis.kg),
    avgSellPerKg: perKg(revenue, soldKg),
    marginPct: revenue.local.isZero() ? null : percentage(grossProfit.local, revenue.local),
    profitPerKg: perKg(grossProfit, soldKg),
    invoiceCount: acc.invoices.size,
  };
}

// --- The report --------------------------------------------------------------

type MovementRow = {
  batchId: string;
  warehouseId: string;
  opening: string;
  received: string;
  transferIn: string;
  transferOut: string;
  sold: string;
  adjustment: string;
  onHand: string;
  reserved: string;
  receivedToDate: string;
  inflowToDate: string;
};

type LineRow = {
  lineId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerId: string;
  customerName: string;
  currency: string;
  rateToUsd: string;
  rateLocalPerUsd: string;
  invoiceTotal: string;
  invoiceTotalUsd: string;
  itemId: string;
  batchId: string;
  warehouseId: string | null;
  quantityKg: string;
  unitPriceKg: string;
  lineTotal: string;
  lineTotalUsd: string;
  taxAmount: string;
  taxAmountUsd: string;
  costTotalUsd: string;
};

export async function getItemProfitability(filters: ItemProfitFilters): Promise<ItemProfitReport> {
  const { companyId } = filters;
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } });
  const local = company.localCurrency;
  const scope = filters.warehouseIds ?? null;

  const from = filters.from ?? null;
  const to = filters.to ?? null;

  // --- Stock: the movement ledger, per batch and warehouse ------------------
  const movementWhere: Prisma.Sql[] = [Prisma.sql`it."companyId" = ${companyId}`, Prisma.sql`b."companyId" = ${companyId}`];
  if (filters.itemId) movementWhere.push(Prisma.sql`b."itemId" = ${filters.itemId}`);
  if (filters.warehouseId) movementWhere.push(Prisma.sql`it."warehouseId" = ${filters.warehouseId}`);
  if (scope) movementWhere.push(Prisma.sql`it."warehouseId" = ANY(${scope}::text[])`);
  if (filters.shipmentId) movementWhere.push(Prisma.sql`b."shipmentId" = ${filters.shipmentId}`);
  if (filters.batchId) movementWhere.push(Prisma.sql`b."id" = ${filters.batchId}`);
  if (filters.containerId) movementWhere.push(Prisma.sql`b."containerId" = ${filters.containerId}`);
  if (to) movementWhere.push(Prisma.sql`it."transactionDate" <= ${to}::date`);
  // A deleted goods receipt or transfer and its undoing cancel to nothing; to
  // the person reading stock they never happened, and the deleted order's
  // renamed reference ("… (reversed …)") must not appear among the item's
  // shipments. Quantities are unchanged by leaving the pair out.
  movementWhere.push(Prisma.sql`NOT (
    (it."referenceType" IN ('GOODS_RECEIPT', 'GOODS_RECEIPT_REVERSAL')
      AND it."referenceId" IN (SELECT gr."id" FROM goods_receipts gr WHERE gr."companyId" = ${companyId} AND gr."status" IN ('REVERSED', 'CANCELLED')))
    OR (it."referenceType" IN ('STOCK_TRANSFER', 'STOCK_TRANSFER_REVERSAL')
      AND it."referenceId" IN (SELECT st."id" FROM stock_transfers st WHERE st."companyId" = ${companyId} AND st."status" IN ('REVERSED', 'CANCELLED')))
  )`);
  const inPeriod = from ? Prisma.sql`it."transactionDate" >= ${from}::date` : Prisma.sql`TRUE`;

  // Every movement type lands in exactly one column, so opening + received +
  // transfers in − transfers out − sold ± adjustments is on hand by construction,
  // and a type nobody expected would show as a break rather than vanish.
  const movementsQuery = prisma.$queryRaw<MovementRow[]>`
    SELECT it."batchId", it."warehouseId",
      COALESCE(SUM(CASE WHEN NOT (${inPeriod}) AND it."transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE') THEN it."quantityKg" END), 0)::text AS opening,
      COALESCE(SUM(CASE WHEN (${inPeriod}) AND it."transactionType" IN ('OPENING','RECEIPT') THEN it."quantityKg" END), 0)::text AS received,
      COALESCE(SUM(CASE WHEN (${inPeriod}) AND it."transactionType" = 'TRANSFER_IN' THEN it."quantityKg" END), 0)::text AS "transferIn",
      COALESCE(-SUM(CASE WHEN (${inPeriod}) AND it."transactionType" = 'TRANSFER_OUT' THEN it."quantityKg" END), 0)::text AS "transferOut",
      COALESCE(-SUM(CASE WHEN (${inPeriod}) AND it."transactionType" = 'SALE' THEN it."quantityKg" END), 0)::text AS sold,
      COALESCE(SUM(CASE WHEN (${inPeriod}) AND it."transactionType" NOT IN ('OPENING','RECEIPT','TRANSFER_IN','TRANSFER_OUT','SALE','RESERVATION','RESERVATION_RELEASE') THEN it."quantityKg" END), 0)::text AS adjustment,
      COALESCE(SUM(CASE WHEN it."transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE') THEN it."quantityKg" END), 0)::text AS "onHand",
      COALESCE(SUM(CASE WHEN it."transactionType" IN ('RESERVATION','RESERVATION_RELEASE') THEN it."quantityKg" END), 0)::text AS reserved,
      COALESCE(SUM(CASE WHEN it."transactionType" IN ('OPENING','RECEIPT') THEN it."quantityKg" END), 0)::text AS "receivedToDate",
      COALESCE(SUM(CASE WHEN it."transactionType" IN ('OPENING','RECEIPT','TRANSFER_IN') THEN it."quantityKg" END), 0)::text AS "inflowToDate"
    FROM inventory_transactions it
    JOIN batches b ON b."id" = it."batchId"
    WHERE ${Prisma.join(movementWhere, ' AND ')}
    GROUP BY it."batchId", it."warehouseId"
  `;

  // --- Sales: posted invoice lines, following the batch they sold from -----
  const lineWhere: Prisma.Sql[] = [Prisma.sql`si."companyId" = ${companyId}`, Prisma.sql`si."status" = 'POSTED'`];
  if (filters.itemId) lineWhere.push(Prisma.sql`sil."itemId" = ${filters.itemId}`);
  if (filters.warehouseId) lineWhere.push(Prisma.sql`sil."warehouseId" = ${filters.warehouseId}`);
  if (scope) lineWhere.push(Prisma.sql`sil."warehouseId" = ANY(${scope}::text[])`);
  if (filters.shipmentId) lineWhere.push(Prisma.sql`b."shipmentId" = ${filters.shipmentId}`);
  if (filters.batchId) lineWhere.push(Prisma.sql`sil."batchId" = ${filters.batchId}`);
  if (filters.containerId) lineWhere.push(Prisma.sql`b."containerId" = ${filters.containerId}`);
  if (from) lineWhere.push(Prisma.sql`si."invoiceDate" >= ${from}::date`);
  if (to) lineWhere.push(Prisma.sql`si."invoiceDate" <= ${to}::date`);

  const linesQuery = prisma.$queryRaw<LineRow[]>`
    SELECT sil."id" AS "lineId", si."id" AS "invoiceId", si."invoiceNumber", si."invoiceDate",
           si."customerId", c."customerName", si."currency",
           si."rateToUsd"::text AS "rateToUsd", si."rateLocalPerUsd"::text AS "rateLocalPerUsd",
           si."totalAmount"::text AS "invoiceTotal", si."totalAmountUsd"::text AS "invoiceTotalUsd",
           sil."itemId", sil."batchId", sil."warehouseId",
           sil."quantityKg"::text AS "quantityKg", sil."unitPriceKg"::text AS "unitPriceKg",
           sil."lineTotal"::text AS "lineTotal", sil."lineTotalUsd"::text AS "lineTotalUsd",
           sil."taxAmount"::text AS "taxAmount", sil."taxAmountUsd"::text AS "taxAmountUsd",
           sil."costTotalUsd"::text AS "costTotalUsd"
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN batches b ON b."id" = sil."batchId"
    JOIN customers c ON c."id" = si."customerId"
    WHERE ${Prisma.join(lineWhere, ' AND ')}
    ORDER BY si."invoiceDate" ASC, si."invoiceNumber" ASC, sil."lineNumber" ASC
  `;

  // Customer credit notes in the period: returns carry their batch; an
  // allowance carries none and is shared over the invoice it credits.
  const creditWhere: Prisma.Sql[] = [
    Prisma.sql`cn."companyId" = ${companyId}`,
    Prisma.sql`cn."status" = 'POSTED'`,
    Prisma.sql`cn."type" = 'CUSTOMER'`,
  ];
  if (from) creditWhere.push(Prisma.sql`cn."creditDate" >= ${from}::date`);
  if (to) creditWhere.push(Prisma.sql`cn."creditDate" <= ${to}::date`);
  const creditsQuery = prisma.$queryRaw<
    Array<{
      id: string;
      salesInvoiceId: string | null;
      currency: string;
      rateToUsd: string;
      rateLocalPerUsd: string;
      batchId: string | null;
      warehouseId: string | null;
      quantityKg: string;
      lineTotal: string;
      lineTotalUsd: string;
      costTotalUsd: string;
    }>
  >`
    SELECT cnl."id", cn."salesInvoiceId", cn."currency",
           cn."rateToUsd"::text AS "rateToUsd", cn."rateLocalPerUsd"::text AS "rateLocalPerUsd",
           cnl."batchId", cnl."warehouseId", cnl."quantityKg"::text AS "quantityKg",
           cnl."lineTotal"::text AS "lineTotal", cnl."lineTotalUsd"::text AS "lineTotalUsd",
           cnl."costTotalUsd"::text AS "costTotalUsd"
    FROM credit_note_lines cnl
    JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
    WHERE ${Prisma.join(creditWhere, ' AND ')}
  `;

  const [movements, lines, credits, ordinals, lowStockPercent] = await Promise.all([
    movementsQuery,
    linesQuery,
    creditsQuery,
    getShipmentOrdinals(companyId),
    getNumberSetting(prisma, companyId, SETTING_KEYS.LOW_STOCK_PERCENT, 10),
  ]);

  // Every line of every invoice touched, so an invoice's payment is shared
  // over all its lines — not just the ones this view happens to show.
  const invoiceIds = [...new Set([...lines.map((l) => l.invoiceId), ...credits.map((c) => c.salesInvoiceId).filter((id): id is string => !!id)])];
  const [allLines, payments, creditTotals] = invoiceIds.length
    ? await Promise.all([
        prisma.$queryRaw<Array<{ id: string; invoiceId: string; batchId: string; warehouseId: string | null; lineTotal: string; taxAmount: string }>>`
          SELECT sil."id", sil."salesInvoiceId" AS "invoiceId", sil."batchId", sil."warehouseId",
                 sil."lineTotal"::text AS "lineTotal", sil."taxAmount"::text AS "taxAmount"
          FROM sales_invoice_lines sil
          JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
          WHERE si."companyId" = ${companyId} AND si."id" = ANY(${invoiceIds}::text[])
          ORDER BY sil."lineNumber" ASC
        `,
        // What Outstanding Invoices counts as paid: posted receipts, less any
        // cheque that bounced or was cancelled.
        prisma.$queryRaw<Array<{ invoiceId: string; paymentMethod: string; amount: string }>>`
          SELECT ra."salesInvoiceId" AS "invoiceId", r."paymentMethod"::text AS "paymentMethod", SUM(ra."amount")::text AS amount
          FROM receipt_allocations ra
          JOIN receipts r ON r."id" = ra."receiptId"
          WHERE r."companyId" = ${companyId} AND r."status" = 'POSTED'
            AND ra."salesInvoiceId" = ANY(${invoiceIds}::text[])
            AND (${to}::date IS NULL OR r."receiptDate" <= ${to}::date)
            AND NOT EXISTS (SELECT 1 FROM cheques ch WHERE ch."receiptId" = r."id" AND ch."status" IN ('BOUNCED', 'CANCELLED'))
          GROUP BY ra."salesInvoiceId", r."paymentMethod"
        `,
        prisma.$queryRaw<Array<{ invoiceId: string; amount: string }>>`
          SELECT cn."salesInvoiceId" AS "invoiceId", SUM(cn."totalAmount")::text AS amount
          FROM credit_notes cn
          WHERE cn."companyId" = ${companyId} AND cn."status" = 'POSTED'
            AND cn."salesInvoiceId" = ANY(${invoiceIds}::text[])
            AND (${to}::date IS NULL OR cn."creditDate" <= ${to}::date)
          GROUP BY cn."salesInvoiceId"
        `,
      ])
    : [[], [], []];

  // --- The batches and warehouses behind it all -----------------------------
  const batchIds = [
    ...new Set([
      ...movements.map((m) => m.batchId),
      ...lines.map((l) => l.batchId),
      ...credits.map((c) => c.batchId).filter((id): id is string => !!id),
      ...allLines.map((l) => l.batchId),
    ]),
  ];
  const [batches, costings, warehouses] = await Promise.all([
    prisma.batch.findMany({
      where: { companyId, id: { in: batchIds } },
      select: {
        id: true,
        batchNumber: true,
        itemId: true,
        shipmentId: true,
        containerId: true,
        lot: { select: { lotNumber: true } },
        container: { select: { containerNumber: true } },
        purchaseContract: { select: { contractReference: true } },
        shipment: { select: { jobNumber: true } },
        item: { select: { itemName: true, itemCode: true, originCountry: true } },
      },
    }),
    batchIds.length ? getBatchCostings({ companyId, batchIds }) : Promise.resolve([]),
    prisma.warehouse.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ]);
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const costingById = new Map(costings.map((c) => [c.batchId, c]));
  const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));
  const landedOf = (batchId: string): Pair => {
    const c = costingById.get(batchId);
    return { local: c ? c.landedPerKgLocal : new Decimal(0), usd: c ? c.landedPerKgUsd : new Decimal(0) };
  };

  // A credit line is in view when its batch and warehouse would be.
  const batchInView = (batchId: string) => {
    const b = batchById.get(batchId);
    if (!b) return false;
    return (
      (!filters.itemId || b.itemId === filters.itemId) &&
      (!filters.shipmentId || b.shipmentId === filters.shipmentId) &&
      (!filters.batchId || b.id === filters.batchId) &&
      (!filters.containerId || b.containerId === filters.containerId)
    );
  };
  const warehouseInView = (warehouseId: string | null) =>
    !!warehouseId && (!filters.warehouseId || warehouseId === filters.warehouseId) && (!scope || scope.includes(warehouseId));

  // --- Cells: one per batch and warehouse -----------------------------------
  const cells = new Map<string, { batchId: string; warehouseId: string; acc: Acc }>();
  const cellFor = (batchId: string, warehouseId: string | null) => {
    const wid = warehouseId ?? '';
    const key = `${batchId}|${wid}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { batchId, warehouseId: wid, acc: emptyAcc() };
      cells.set(key, cell);
    }
    return cell.acc;
  };

  for (const m of movements) {
    const acc = cellFor(m.batchId, m.warehouseId);
    const landed = landedOf(m.batchId);
    acc.openingKg = acc.openingKg.plus(dec(m.opening));
    acc.receivedKg = acc.receivedKg.plus(dec(m.received));
    acc.transferInKg = acc.transferInKg.plus(dec(m.transferIn));
    acc.transferOutKg = acc.transferOutKg.plus(dec(m.transferOut));
    acc.stockSoldKg = acc.stockSoldKg.plus(dec(m.sold));
    acc.adjustmentKg = acc.adjustmentKg.plus(dec(m.adjustment));
    const onHand = dec(m.onHand);
    acc.onHandKg = acc.onHandKg.plus(onHand);
    acc.reservedKg = acc.reservedKg.plus(dec(m.reserved));
    acc.stockValue = addPair(acc.stockValue, { local: onHand.times(landed.local), usd: onHand.times(landed.usd) });
    const receivedToDate = dec(m.receivedToDate);
    const inflowToDate = dec(m.inflowToDate);
    acc.receivedBasis = {
      kg: acc.receivedBasis.kg.plus(receivedToDate),
      value: addPair(acc.receivedBasis.value, { local: receivedToDate.times(landed.local), usd: receivedToDate.times(landed.usd) }),
    };
    acc.inflowBasis = {
      kg: acc.inflowBasis.kg.plus(inflowToDate),
      value: addPair(acc.inflowBasis.value, { local: inflowToDate.times(landed.local), usd: inflowToDate.times(landed.usd) }),
    };
  }

  // --- Invoice-level money, shared over each invoice's lines ----------------
  type InvoiceMoney = { paid: Record<CollectionMethod, Decimal>; credited: Decimal };
  const invoiceMoney = new Map<string, InvoiceMoney>();
  const moneyOf = (invoiceId: string) => {
    let entry = invoiceMoney.get(invoiceId);
    if (!entry) {
      entry = {
        paid: Object.fromEntries(COLLECTION_METHODS.map((m) => [m, new Decimal(0)])) as Record<CollectionMethod, Decimal>,
        credited: new Decimal(0),
      };
      invoiceMoney.set(invoiceId, entry);
    }
    return entry;
  };
  for (const p of payments) {
    const entry = moneyOf(p.invoiceId);
    const method = methodOf(p.paymentMethod);
    entry.paid[method] = entry.paid[method].plus(dec(p.amount));
  }
  for (const c of creditTotals) moneyOf(c.invoiceId).credited = dec(c.amount);

  // Each line's share of its invoice's payments and credits, in the invoice's currency.
  const linesByInvoice = new Map<string, typeof allLines>();
  for (const line of allLines) {
    const list = linesByInvoice.get(line.invoiceId) ?? [];
    list.push(line);
    linesByInvoice.set(line.invoiceId, list);
  }
  const shareOf = new Map<string, { paid: Record<CollectionMethod, Decimal>; credited: Decimal }>();
  for (const [invoiceId, invoiceLines] of linesByInvoice) {
    const money = moneyOf(invoiceId);
    const weights = invoiceLines.map((l) => dec(l.lineTotal).plus(dec(l.taxAmount)));
    const paidShares = Object.fromEntries(
      COLLECTION_METHODS.map((m) => [m, allocateProportionally(money.paid[m], weights)]),
    ) as Record<CollectionMethod, Decimal[]>;
    const creditShares = allocateProportionally(money.credited, weights);
    invoiceLines.forEach((line, i) => {
      shareOf.set(line.id, {
        paid: Object.fromEntries(COLLECTION_METHODS.map((m) => [m, paidShares[m][i]])) as Record<CollectionMethod, Decimal>,
        credited: creditShares[i],
      });
    });
  }

  // --- Sales lines -----------------------------------------------------------
  const saleLines: ItemSaleLine[] = [];
  const itemsPerInvoice = new Map<string, Set<string>>();
  for (const line of allLines) {
    const itemId = batchById.get(line.batchId)?.itemId ?? '';
    const set = itemsPerInvoice.get(line.invoiceId) ?? new Set<string>();
    set.add(itemId);
    itemsPerInvoice.set(line.invoiceId, set);
  }

  for (const row of lines) {
    const batch = batchById.get(row.batchId);
    if (!batch) continue;
    const rates = { currency: row.currency, rateToUsd: row.rateToUsd, localCurrency: local, rateLocalPerUsd: row.rateLocalPerUsd };
    const toPair = (amount: Decimal): Pair => ({
      local: convertToLocal({ amount, ...rates }),
      usd: convertToUsd(amount, row.rateToUsd, row.currency),
    });
    const quantityKg = dec(row.quantityKg);
    const landed = landedOf(row.batchId);
    const amount: Pair = { local: convertToLocal({ amount: row.lineTotal, ...rates }), usd: toMoney(row.lineTotalUsd) };
    const gross: Pair = {
      local: convertToLocal({ amount: dec(row.lineTotal).plus(dec(row.taxAmount)), ...rates }),
      usd: toMoney(dec(row.lineTotalUsd).plus(dec(row.taxAmountUsd))),
    };
    // Cost as posted on the line in USD; in the company's currency, the KG at
    // the batch's landed cost at the rates that cost was incurred at.
    const cogs: Pair = { local: toMoney(quantityKg.times(landed.local)), usd: toMoney(row.costTotalUsd) };
    const share = shareOf.get(row.lineId);
    const collected = Object.fromEntries(
      COLLECTION_METHODS.map((m) => [m, toPair(share?.paid[m] ?? new Decimal(0))]),
    ) as Record<CollectionMethod, Pair>;
    const collectedTotal = COLLECTION_METHODS.reduce((sum, m) => addPair(sum, collected[m]), zeroPair());
    const credited = toPair(share?.credited ?? new Decimal(0));
    const outstanding = subPair(subPair(gross, collectedTotal), credited);

    const money = moneyOf(row.invoiceId);
    const invoicePaidAmount = COLLECTION_METHODS.reduce((sum, m) => sum.plus(money.paid[m]), new Decimal(0)).plus(money.credited);
    const invoiceOutstandingAmount = dec(row.invoiceTotal).minus(invoicePaidAmount);

    const acc = cellFor(row.batchId, row.warehouseId);
    acc.soldKg = acc.soldKg.plus(quantityKg);
    acc.revenue = addPair(acc.revenue, amount);
    acc.cogs = addPair(acc.cogs, cogs);
    acc.invoiced = addPair(acc.invoiced, gross);
    for (const m of COLLECTION_METHODS) acc.collected[m] = addPair(acc.collected[m], collected[m]);
    acc.credited = addPair(acc.credited, credited);
    acc.outstanding = addPair(acc.outstanding, outstanding);
    acc.invoices.add(row.invoiceId);

    saleLines.push({
      lineId: row.lineId,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      customerId: row.customerId,
      customerName: row.customerName,
      itemId: row.itemId,
      batchId: row.batchId,
      batchNumber: batch.batchNumber,
      containerNumber: batch.container?.containerNumber ?? null,
      shipmentId: batch.shipmentId,
      shipmentLabel: shipmentOrdinalLabel(ordinals.get(batch.shipmentId)),
      reference: batch.purchaseContract.contractReference,
      warehouseId: row.warehouseId ?? '',
      warehouseName: warehouseName.get(row.warehouseId ?? '') ?? '—',
      quantityKg: toQuantity(quantityKg),
      currency: row.currency,
      ratePerKg: toUnitCost(row.unitPriceKg),
      amount: moneyPair(amount),
      cogs: moneyPair(cogs),
      profit: moneyPair(subPair(amount, cogs)),
      gross: moneyPair(gross),
      collected: Object.fromEntries(COLLECTION_METHODS.map((m) => [m, moneyPair(collected[m])])) as Record<CollectionMethod, Pair>,
      collectedTotal: moneyPair(collectedTotal),
      credited: moneyPair(credited),
      outstanding: moneyPair(outstanding),
      invoiceTotal: { local: convertToLocal({ amount: row.invoiceTotal, ...rates }), usd: toMoney(row.invoiceTotalUsd) },
      invoicePaid: toPair(invoicePaidAmount),
      invoiceOutstanding: toPair(invoiceOutstandingAmount),
      status: invoiceOutstandingAmount.lessThanOrEqualTo(0) ? 'PAID' : invoicePaidAmount.greaterThan(0) ? 'PARTIAL' : 'UNPAID',
      shared: (itemsPerInvoice.get(row.invoiceId)?.size ?? 1) > 1 || (linesByInvoice.get(row.invoiceId)?.length ?? 1) > 1,
    });
  }

  // --- Credit notes: returns and allowances reduce the sale they undo -------
  const lineInView = new Set(lines.map((l) => l.lineId));
  for (const credit of credits) {
    const rates = { currency: credit.currency, rateToUsd: credit.rateToUsd, localCurrency: local, rateLocalPerUsd: credit.rateLocalPerUsd };
    const value: Pair = { local: convertToLocal({ amount: credit.lineTotal, ...rates }), usd: toMoney(credit.lineTotalUsd) };
    if (credit.batchId) {
      if (!batchInView(credit.batchId) || !warehouseInView(credit.warehouseId)) continue;
      const acc = cellFor(credit.batchId, credit.warehouseId);
      const quantityKg = dec(credit.quantityKg);
      const landed = landedOf(credit.batchId);
      acc.soldKg = acc.soldKg.minus(quantityKg);
      acc.revenue = subPair(acc.revenue, value);
      acc.cogs = subPair(acc.cogs, { local: quantityKg.times(landed.local), usd: dec(credit.costTotalUsd) });
      continue;
    }
    // An allowance names no coffee: shared over the invoice's lines by value.
    if (!credit.salesInvoiceId) continue;
    const invoiceLines = linesByInvoice.get(credit.salesInvoiceId) ?? [];
    if (invoiceLines.length === 0) continue;
    const weights = invoiceLines.map((l) => dec(l.lineTotal));
    const localShares = allocateProportionally(value.local, weights);
    const usdShares = allocateProportionally(value.usd, weights);
    invoiceLines.forEach((line, i) => {
      if (!lineInView.has(line.id)) return;
      const acc = cellFor(line.batchId, line.warehouseId);
      acc.revenue = subPair(acc.revenue, { local: localShares[i], usd: usdShares[i] });
    });
  }

  // --- Roll the cells up: item → warehouse, item → shipment → container → batch → warehouse
  type ItemAcc = {
    acc: Acc;
    warehouses: Map<string, Acc>;
    shipments: Map<string, { acc: Acc; containers: Map<string, { acc: Acc; batches: Map<string, { acc: Acc; warehouses: Map<string, Acc> }> }> }>;
  };
  const itemAccs = new Map<string, ItemAcc>();
  const totalAcc = emptyAcc();
  const getOr = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
    let value = map.get(key);
    if (value === undefined) {
      value = make();
      map.set(key, value);
    }
    return value;
  };

  for (const cell of cells.values()) {
    const batch = batchById.get(cell.batchId);
    if (!batch) continue;
    const item = getOr(itemAccs, batch.itemId, () => ({ acc: emptyAcc(), warehouses: new Map(), shipments: new Map() }));
    addInto(item.acc, cell.acc);
    addInto(totalAcc, cell.acc);
    addInto(getOr(item.warehouses, cell.warehouseId, emptyAcc), cell.acc);
    const shipment = getOr(item.shipments, batch.shipmentId, () => ({ acc: emptyAcc(), containers: new Map() }));
    addInto(shipment.acc, cell.acc);
    const container = getOr(shipment.containers, batch.containerId ?? '', () => ({ acc: emptyAcc(), batches: new Map() }));
    addInto(container.acc, cell.acc);
    const batchNode = getOr(container.batches, batch.id, () => ({ acc: emptyAcc(), warehouses: new Map() }));
    addInto(batchNode.acc, cell.acc);
    addInto(getOr(batchNode.warehouses, cell.warehouseId, emptyAcc), cell.acc);
  }

  // A warehouse filter narrows everything to one site, where the transfers in are its stock.
  const siteBasis: 'received' | 'inflow' = filters.warehouseId ? 'inflow' : 'received';
  const warehouseNodes = (map: Map<string, Acc>): WarehouseNode[] =>
    [...map.entries()]
      .map(([warehouseId, acc]) => ({ warehouseId, warehouseName: warehouseName.get(warehouseId) ?? '—', ...measure(acc, 'inflow') }))
      .sort((a, b) => a.warehouseName.localeCompare(b.warehouseName));

  const items: ItemNode[] = [...itemAccs.entries()].map(([itemId, item]) => {
    const anyBatch = batches.find((b) => b.itemId === itemId)!;
    const measures = measure(item.acc, siteBasis);
    const shipments: ShipmentNode[] = [...item.shipments.entries()]
      .map(([shipmentId, shipment]) => {
        const sample = batches.find((b) => b.shipmentId === shipmentId)!;
        return {
          shipmentId,
          shipmentLabel: shipmentOrdinalLabel(ordinals.get(shipmentId)),
          reference: sample.purchaseContract.contractReference,
          jobNumber: sample.shipment.jobNumber,
          ...measure(shipment.acc, siteBasis),
          containers: [...shipment.containers.entries()]
            .map(([containerKey, container]) => {
              const containerBatch = batches.find((b) => (b.containerId ?? '') === containerKey && b.shipmentId === shipmentId);
              return {
                containerKey,
                containerNumber: containerBatch?.container?.containerNumber ?? null,
                ...measure(container.acc, siteBasis),
                batches: [...container.batches.entries()]
                  .map(([batchId, node]) => {
                    const b = batchById.get(batchId)!;
                    return {
                      batchId,
                      batchNumber: b.batchNumber,
                      lotNumber: b.lot.lotNumber,
                      containerNumber: b.container?.containerNumber ?? null,
                      landedPerKg: landedOf(batchId),
                      ...measure(node.acc, siteBasis),
                      warehouses: warehouseNodes(node.warehouses),
                    };
                  })
                  .sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
              };
            })
            .sort((a, b) => (a.containerNumber ?? '').localeCompare(b.containerNumber ?? '')),
        };
      })
      .sort((a, b) => a.reference.localeCompare(b.reference) || a.shipmentLabel.localeCompare(b.shipmentLabel));

    const receivedBase = item.acc.receivedBasis.kg;
    const status: StockStatus = measures.availableKg.lessThanOrEqualTo(0)
      ? 'SOLD_OUT'
      : receivedBase.greaterThan(0) && measures.availableKg.lessThan(receivedBase.times(lowStockPercent).dividedBy(100))
        ? 'LOW_STOCK'
        : 'IN_STOCK';

    return {
      itemId,
      itemName: anyBatch.item.itemName,
      itemCode: anyBatch.item.itemCode,
      origin: anyBatch.item.originCountry,
      status,
      ...measures,
      warehouses: warehouseNodes(item.warehouses),
      shipments,
    };
  });
  items.sort((a, b) => a.itemName.localeCompare(b.itemName));

  return {
    localCurrency: local,
    lowStockPercent,
    items,
    total: measure(totalAcc, siteBasis),
    lines: saleLines,
  };
}

// --- Reconciliation ------------------------------------------------------------

export type ItemCheck = {
  key: string;
  label: string;
  /** What this view says. */
  shown: string;
  /** What the rest of the ERP says. */
  source: string;
  sourceLabel: string;
  ok: boolean;
  /** Numeric values behind the strings, for tests and the consistency page. */
  shownValue: Decimal;
  sourceValue: Decimal;
  unit: 'KG' | 'LOCAL' | 'USD';
};

/**
 * The item view checked against the records other screens read.
 *
 * The per-item stock and money identities hold by construction; these are the
 * ones that can only hold if the item view and the rest of the ERP agree. Run
 * over the whole company, unfiltered, because that is the figure the other
 * screens show.
 */
export async function getItemProfitabilityChecks(companyId: string, report?: ItemProfitReport): Promise<ItemCheck[]> {
  const whole = report ?? (await getItemProfitability({ companyId }));
  const local = whole.localCurrency;
  const t = whole.total;

  const [balances, headers, credits, receivables] = await Promise.all([
    prisma.inventoryBalance.aggregate({ where: { companyId }, _sum: { onHandKg: true } }),
    prisma.$queryRaw<Array<{ revenueLocal: string; revenueUsd: string; cogsUsd: string }>>`
      SELECT COALESCE(SUM(CASE WHEN si."currency" = ${local} THEN si."subtotal" ELSE si."subtotalUsd" * si."rateLocalPerUsd" END), 0)::text AS "revenueLocal",
             COALESCE(SUM(si."subtotalUsd"), 0)::text AS "revenueUsd",
             COALESCE(SUM(si."costOfGoodsUsd"), 0)::text AS "cogsUsd"
      FROM sales_invoices si
      WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'
    `,
    prisma.$queryRaw<Array<{ revenueLocal: string; revenueUsd: string; cogsUsd: string }>>`
      SELECT COALESCE(SUM(CASE WHEN cn."currency" = ${local} THEN cn."subtotalAmount" ELSE cn."subtotalAmountUsd" * cn."rateLocalPerUsd" END), 0)::text AS "revenueLocal",
             COALESCE(SUM(cn."subtotalAmountUsd"), 0)::text AS "revenueUsd",
             COALESCE(SUM(cn."costOfGoodsUsd"), 0)::text AS "cogsUsd"
      FROM credit_notes cn
      WHERE cn."companyId" = ${companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
    `,
    getReceivables({ companyId }),
  ]);

  // Outstanding on sales invoices — the opening balances brought forward
  // have no coffee behind them and belong to no item.
  const invoiceIds = new Set(
    (await prisma.salesInvoice.findMany({ where: { companyId, status: 'POSTED' }, select: { id: true } })).map((i) => i.id),
  );
  const outstandingLocal = receivables
    .filter((r) => invoiceIds.has(r.invoiceId))
    .reduce(
      (sum, r) =>
        sum.plus(
          r.currency === local
            ? r.outstandingAmount
            : convertFromUsd(r.outstandingAmountUsd, r.rateLocalPerUsd, local),
        ),
      new Decimal(0),
    );

  // Shipment Profitability's cost of sales in the company's currency: the KG
  // each batch has sold at its landed cost in that currency.
  const soldBatches = await prisma.batch.findMany({ where: { companyId, soldQuantityKg: { not: 0 } }, select: { id: true, soldQuantityKg: true } });
  const costings = soldBatches.length ? await getBatchCostings({ companyId, batchIds: soldBatches.map((b) => b.id) }) : [];
  const landedLocal = new Map(costings.map((c) => [c.batchId, c.landedPerKgLocal]));
  const shipmentCogsLocal = soldBatches.reduce((sum, b) => sum.plus(dec(b.soldQuantityKg).times(landedLocal.get(b.id) ?? 0)), new Decimal(0));

  const warehouseAvailable = whole.items.reduce(
    (sum, item) => sum.plus(item.warehouses.reduce((s, w) => s.plus(w.availableKg), new Decimal(0))),
    new Decimal(0),
  );
  const equation = t.openingKg.plus(t.receivedKg).plus(t.transferInKg).minus(t.transferOutKg).minus(t.stockSoldKg).plus(t.adjustmentKg);
  const received = t.collectedTotal.local.plus(t.credited.local).plus(t.outstanding.local);

  const check = (
    key: string,
    label: string,
    unit: ItemCheck['unit'],
    shownValue: Decimal,
    sourceValue: Decimal,
    sourceLabel: string,
    tolerance = unit === 'KG' ? '0.001' : '0.01',
  ): ItemCheck => {
    const fmt = (v: Decimal) => (unit === 'KG' ? `${toQuantity(v).toFixed(3)} KG` : `${unit === 'USD' ? 'USD' : local} ${toMoney(v).toFixed(2)}`);
    return {
      key,
      label,
      shown: fmt(shownValue),
      source: fmt(sourceValue),
      sourceLabel,
      ok: shownValue.minus(sourceValue).abs().lessThanOrEqualTo(dec(tolerance)),
      shownValue: toMoney(shownValue),
      sourceValue: toMoney(sourceValue),
      unit,
    };
  };

  return [
    check('stock-equation', 'Received + transfers in − transfers out − sold ± adjustments = on hand', 'KG', equation, t.onHandKg, 'On hand, movement ledger'),
    check('stock-current', 'On hand = Current Stock', 'KG', t.onHandKg, dec(balances._sum.onHandKg ?? 0), 'Current Stock (warehouse balances)'),
    check('stock-warehouses', 'Sum of warehouses = company available stock', 'KG', warehouseAvailable, t.availableKg, 'Company available stock'),
    check('sold-kg', 'Sold KG on invoice lines = sold KG in the stock ledger', 'KG', t.soldKg, t.stockSoldKg, 'Stock ledger sales'),
    check(
      'revenue',
      'Sales revenue = posted sales invoices less credit notes',
      'LOCAL',
      t.revenue.local,
      dec(headers[0]?.revenueLocal ?? 0).minus(dec(credits[0]?.revenueLocal ?? 0)),
      'Sales invoices',
    ),
    check(
      'cogs-usd',
      'Cost of goods sold (USD) = cost posted on the invoices',
      'USD',
      t.cogs.usd,
      dec(headers[0]?.cogsUsd ?? 0).minus(dec(credits[0]?.cogsUsd ?? 0)),
      'Sales invoices',
    ),
    check('cogs-local', `Cost of goods sold (${local}) = Shipment Profitability`, 'LOCAL', t.cogs.local, shipmentCogsLocal, 'Shipment Profitability'),
    check('profit', 'Gross profit = revenue − cost of goods sold', 'LOCAL', t.grossProfit.local, t.revenue.local.minus(t.cogs.local), 'Revenue − COGS'),
    check('collected', 'Collected + credited + outstanding = invoiced', 'LOCAL', received, t.invoiced.local, 'Invoiced'),
    check('outstanding', 'Outstanding = Outstanding Invoices', 'LOCAL', t.outstanding.local, outstandingLocal, 'Outstanding Invoices (sales invoices)'),
  ];
}
