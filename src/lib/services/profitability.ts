import { getOverheadByShipment } from '@/lib/services/overhead-allocation';
import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity, toUnitCost, percentage } from '@/lib/money';

/**
 * ProfitabilityService.
 *
 * Every figure is computed from posted transactions. There is no stored "net
 * profit" column anywhere in the schema and no screen lets a user type one.
 *
 *   Allocated Landed Cost = sold KG x the batch's current landed cost per KG
 *   Gross Profit          = Sales Revenue − Allocated Landed Cost
 *   Net Profit            = Gross Profit  − Other (period) job costs
 *   Profit per KG         = Net Profit / sold KG
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never counts unsold coffee as revenue. A job that is half sold shows
 *     the margin on the half that sold; the rest stays on the balance sheet as
 *     inventory.
 *   - It never double-counts freight. Contract freight and capitalised direct
 *     costs are already inside the batch's landed cost, so they reach the
 *     profit figure through cost of goods sold and are not deducted again.
 *     Only genuinely period costs — bank charges, commission, storage — appear
 *     as "other costs".
 */

export type ShipmentProfitability = {
  shipmentId: string;
  shipmentNumber: string;
  jobNumber: string;
  contractId: string;
  contractNumber: string;
  contractReference: string;
  status: string;
  itemName: string;
  vendorName: string;
  customerNames: string[];
  purchaseQuantityKg: Decimal;
  receivedQuantityKg: Decimal;
  soldQuantityKg: Decimal;
  remainingQuantityKg: Decimal;
  bags: number;
  goodsCostUsd: Decimal;
  capitalisedCostUsd: Decimal;
  totalLandedCostUsd: Decimal;
  landedCostPerKgUsd: Decimal;
  /** Landed cost of the coffee that has actually been sold. */
  allocatedLandedCostUsd: Decimal;
  salesRevenueUsd: Decimal;
  /** Sales value over the kilograms sold — what a kilogram actually fetched. */
  averageSellingPriceUsd: Decimal;
  /** What is left on the shelf, at the batch's landed cost — the same basis the valuation and the balance sheet use. */
  onHandQuantityKg: Decimal;
  closingStockValueUsd: Decimal;
  grossProfitUsd: Decimal;
  /** Period costs booked to the job but not capitalised into stock. */
  otherCostsUsd: Decimal;
  netProfitUsd: Decimal;
  profitPerKgUsd: Decimal;
  grossMarginPct: Decimal;
  netMarginPct: Decimal;
  /**
   * This shipment's share of company overheads, when management has chosen to
   * allocate them. It is a management figure only: it is not in the ledger,
   * not in the company profit and loss, and not in `netProfitUsd`.
   */
  allocatedOverheadUsd: Decimal;
  /** Net profit after that management share — the "fully absorbed" view. */
  profitAfterOverheadUsd: Decimal;
  /** Purchase USD converted at the contract rate, plus local costs. */
  goodsCostLocal: Decimal;
  /** Direct shipment costs in the company's currency, at the contract rate — the same rate COGS uses. */
  capitalisedCostLocal: Decimal;
  totalLandedCostLocal: Decimal;
  landedCostPerKgLocal: Decimal;
  allocatedLandedCostLocal: Decimal;
  salesRevenueLocal: Decimal;
  averageSellingPriceLocal: Decimal;
  closingStockValueLocal: Decimal;
  otherCostsLocal: Decimal;
  grossProfitLocal: Decimal;
  netProfitLocal: Decimal;
  profitPerKgLocal: Decimal;
};

type RawRow = {
  shipmentId: string;
  shipmentNumber: string;
  jobNumber: string;
  contractId: string;
  contractNumber: string;
  contractReference: string;
  status: string;
  itemName: string;
  vendorName: string;
  customerNames: string | null;
  orderedKg: string;
  receivedKg: string;
  soldKg: string;
  bags: string;
  goodsCostUsd: string;
  capitalisedCostUsd: string;
  allocatedLandedCostUsd: string;
  salesRevenueUsd: string;
  otherCostsUsd: string;
  onHandKg: string;
  closingStockValueUsd: string;
  goodsCostLocal: string;
  capitalisedCostLocal: string;
  allocatedLandedCostLocal: string;
  salesRevenueLocal: string;
  otherCostsLocal: string;
};

function shape(row: RawRow): ShipmentProfitability {
  // The order's own rate, the one the goods and their costs were converted at.
  const rateLocalPerUsd = dec(row.goodsCostUsd).isZero() ? dec(1) : dec(row.goodsCostLocal).dividedBy(row.goodsCostUsd);
  const purchaseQuantityKg = toQuantity(row.orderedKg);
  const soldQuantityKg = toQuantity(row.soldKg);
  const goodsCostUsd = toMoney(row.goodsCostUsd);
  const capitalisedCostUsd = toMoney(row.capitalisedCostUsd);
  const totalLandedCostUsd = toMoney(goodsCostUsd.plus(capitalisedCostUsd));
  const allocatedLandedCostUsd = toMoney(row.allocatedLandedCostUsd);
  const salesRevenueUsd = toMoney(row.salesRevenueUsd);
  const onHandQuantityKg = toQuantity(row.onHandKg);
  const closingStockValueUsd = toMoney(row.closingStockValueUsd);
  const otherCostsUsd = toMoney(row.otherCostsUsd);
  const grossProfitUsd = toMoney(salesRevenueUsd.minus(allocatedLandedCostUsd));
  const netProfitUsd = toMoney(grossProfitUsd.minus(otherCostsUsd));
  const goodsCostLocal = toMoney(row.goodsCostLocal);
  const capitalisedCostLocal = toMoney(row.capitalisedCostLocal);
  const totalLandedCostLocal = toMoney(goodsCostLocal.plus(capitalisedCostLocal));
  const allocatedLandedCostLocal = toMoney(row.allocatedLandedCostLocal);
  const salesRevenueLocal = toMoney(row.salesRevenueLocal);
  const otherCostsLocal = toMoney(row.otherCostsLocal);
  const grossProfitLocal = toMoney(salesRevenueLocal.minus(allocatedLandedCostLocal));
  const netProfitLocal = toMoney(grossProfitLocal.minus(otherCostsLocal));

  return {
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipmentNumber,
    jobNumber: row.jobNumber,
    contractId: row.contractId,
    contractNumber: row.contractNumber,
    contractReference: row.contractReference,
    status: row.status,
    itemName: row.itemName,
    vendorName: row.vendorName,
    customerNames: row.customerNames ? row.customerNames.split(', ') : [],
    purchaseQuantityKg,
    receivedQuantityKg: toQuantity(row.receivedKg),
    soldQuantityKg,
    remainingQuantityKg: toQuantity(purchaseQuantityKg.minus(soldQuantityKg)),
    bags: Number(row.bags),
    goodsCostUsd,
    capitalisedCostUsd,
    totalLandedCostUsd,
    landedCostPerKgUsd: purchaseQuantityKg.greaterThan(0)
      ? toUnitCost(totalLandedCostUsd.dividedBy(purchaseQuantityKg))
      : new Decimal(0),
    allocatedLandedCostUsd,
    salesRevenueUsd,
    averageSellingPriceUsd: soldQuantityKg.greaterThan(0)
      ? toUnitCost(salesRevenueUsd.dividedBy(soldQuantityKg))
      : new Decimal(0),
    onHandQuantityKg,
    closingStockValueUsd,
    grossProfitUsd,
    otherCostsUsd,
    netProfitUsd,
    profitPerKgUsd: soldQuantityKg.greaterThan(0)
      ? toUnitCost(netProfitUsd.dividedBy(soldQuantityKg))
      : new Decimal(0),
    allocatedOverheadUsd: new Decimal(0),
    profitAfterOverheadUsd: netProfitUsd,
    grossMarginPct: percentage(grossProfitUsd, salesRevenueUsd),
    netMarginPct: percentage(netProfitUsd, salesRevenueUsd),
    goodsCostLocal,
    capitalisedCostLocal,
    totalLandedCostLocal,
    landedCostPerKgLocal: purchaseQuantityKg.greaterThan(0)
      ? toUnitCost(totalLandedCostLocal.dividedBy(purchaseQuantityKg))
      : new Decimal(0),
    allocatedLandedCostLocal,
    salesRevenueLocal,
    averageSellingPriceLocal: soldQuantityKg.greaterThan(0)
      ? toUnitCost(salesRevenueLocal.dividedBy(soldQuantityKg))
      : new Decimal(0),
    closingStockValueLocal: toMoney(closingStockValueUsd.times(rateLocalPerUsd)),
    otherCostsLocal,
    grossProfitLocal,
    netProfitLocal,
    profitPerKgLocal: soldQuantityKg.greaterThan(0)
      ? toUnitCost(netProfitLocal.dividedBy(soldQuantityKg))
      : new Decimal(0),
  };
}

export async function getShipmentProfitability(params: {
  companyId: string;
  shipmentId?: string;
  from?: Date;
  to?: Date;
}): Promise<ShipmentProfitability[]> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      s."id" AS "shipmentId", s."shipmentNumber", s."jobNumber", s."status"::text AS status,
      pc."id" AS "contractId", pc."contractNumber", pc."contractReference",
      ci."itemName", v."vendorName",
      (SELECT string_agg(DISTINCT c2."customerName", ', ')
         FROM sales_invoices si2
         JOIN customers c2 ON c2."id" = si2."customerId"
        WHERE si2."shipmentId" = s."id" AND si2."status" = 'POSTED') AS "customerNames",
      COALESCE((SELECT SUM(b."orderedQuantityKg")  FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "orderedKg",
      COALESCE((SELECT SUM(b."receivedQuantityKg") FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "receivedKg",
      COALESCE((SELECT SUM(b."soldQuantityKg")     FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "soldKg",
      COALESCE((SELECT SUM(b."orderedBags")        FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS bags,
      COALESCE((SELECT SUM(b."purchaseCostUsd")    FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "goodsCostUsd",
      COALESCE((SELECT SUM(b."capitalisedCostUsd") FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "capitalisedCostUsd",
      -- Landed cost of what actually sold, at each batch's current landed rate.
      COALESCE((SELECT SUM(b."soldQuantityKg" * b."landedUnitCostUsd")
                  FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "allocatedLandedCostUsd",
      /*
       * Revenue follows the coffee, not the invoice header.
       *
       * One invoice routinely sells from two shipments of the same order, and
       * its header can name only one of them. Attributing revenue by the
       * header while cost of sales follows each line's batch left shipments
       * showing a cost with no sale against it, and the shipment results
       * stopped adding up to the company's. Both now walk the same path:
       * line to batch to shipment.
       */
      (COALESCE((SELECT SUM(sil."lineTotalUsd")
                   FROM sales_invoice_lines sil
                   JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
                   JOIN batches b4 ON b4."id" = sil."batchId"
                  WHERE b4."shipmentId" = s."id" AND si."status" = 'POSTED'), 0)
       - COALESCE((SELECT SUM(cnl."lineTotalUsd")
                     FROM credit_note_lines cnl
                     JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                     JOIN batches b3 ON b3."id" = cnl."batchId"
                    WHERE b3."shipmentId" = s."id" AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'), 0)
       -- A credit for an allowance names no coffee, so it is shared over the
       -- shipments of the invoice it credits, in proportion to what each sold
       -- on that invoice. Without this the allowance would leave the shipment
       -- results while staying in the company's.
       - COALESCE((SELECT SUM(cnl."lineTotalUsd" * (SELECT COALESCE(SUM(sil2."lineTotalUsd"), 0) FROM sales_invoice_lines sil2
                            JOIN batches b7 ON b7."id" = sil2."batchId"
                           WHERE sil2."salesInvoiceId" = cn."salesInvoiceId" AND b7."shipmentId" = s."id")
                         / NULLIF((SELECT SUM(sil3."lineTotalUsd") FROM sales_invoice_lines sil3
                                    WHERE sil3."salesInvoiceId" = cn."salesInvoiceId"), 0))
                     FROM credit_note_lines cnl
                     JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                    WHERE cnl."batchId" IS NULL AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                      AND cn."companyId" = s."companyId" AND cn."salesInvoiceId" IS NOT NULL), 0)
      )::text AS "salesRevenueUsd",
      -- Only period costs. Capitalised costs already sit inside landed cost.
      COALESCE((SELECT SUM(e."amountUsd") FROM expenses e
                 WHERE e."shipmentId" = s."id" AND e."status" = 'POSTED'
                   AND e."capitaliseToLandedCost" = false), 0)::text AS "otherCostsUsd",
      -- What is still on the shelf, and what it is carried at. The same
      -- basis as the inventory valuation, so a shipment's remaining stock and
      -- the company's inventory asset are one figure read two ways.
      COALESCE((SELECT SUM(ib."onHandKg") FROM batches b
                  JOIN inventory_balances ib ON ib."batchId" = b."id"
                 WHERE b."shipmentId" = s."id"), 0)::text AS "onHandKg",
      COALESCE((SELECT SUM(ib."onHandKg" * b."landedUnitCostUsd") FROM batches b
                  JOIN inventory_balances ib ON ib."batchId" = b."id"
                 WHERE b."shipmentId" = s."id"), 0)::text AS "closingStockValueUsd",
      COALESCE((SELECT SUM(b."purchaseCostUsd" * pc."rateLocalPerUsd")
                  FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "goodsCostLocal",
      COALESCE((SELECT SUM(b."capitalisedCostUsd" * pc."rateLocalPerUsd")
                  FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "capitalisedCostLocal",
      COALESCE((SELECT SUM(b."soldQuantityKg" * b."landedUnitCostUsd" * pc."rateLocalPerUsd")
                  FROM batches b WHERE b."shipmentId" = s."id"), 0)::text AS "allocatedLandedCostLocal",
      -- The same path in the company's own currency, at each invoice's rate.
      (COALESCE((SELECT SUM(sil."lineTotalUsd" * si."rateLocalPerUsd")
                   FROM sales_invoice_lines sil
                   JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
                   JOIN batches b5 ON b5."id" = sil."batchId"
                  WHERE b5."shipmentId" = s."id" AND si."status" = 'POSTED'), 0)
       - COALESCE((SELECT SUM(cnl."lineTotalUsd" * cn."rateLocalPerUsd")
                     FROM credit_note_lines cnl
                     JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                     JOIN batches b6 ON b6."id" = cnl."batchId"
                    WHERE b6."shipmentId" = s."id" AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'), 0)
       - COALESCE((SELECT SUM(cnl."lineTotalUsd" * cn."rateLocalPerUsd" * (SELECT COALESCE(SUM(sil2."lineTotalUsd"), 0) FROM sales_invoice_lines sil2
                            JOIN batches b7 ON b7."id" = sil2."batchId"
                           WHERE sil2."salesInvoiceId" = cn."salesInvoiceId" AND b7."shipmentId" = s."id")
                         / NULLIF((SELECT SUM(sil3."lineTotalUsd") FROM sales_invoice_lines sil3
                                    WHERE sil3."salesInvoiceId" = cn."salesInvoiceId"), 0))
                     FROM credit_note_lines cnl
                     JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                    WHERE cnl."batchId" IS NULL AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                      AND cn."companyId" = s."companyId" AND cn."salesInvoiceId" IS NOT NULL), 0)
      )::text AS "salesRevenueLocal",
      COALESCE((SELECT SUM(e."amountLocal") FROM expenses e
                 WHERE e."shipmentId" = s."id" AND e."status" = 'POSTED'
                   AND e."capitaliseToLandedCost" = false), 0)::text AS "otherCostsLocal"
    FROM shipments s
    JOIN coffee_items ci ON ci."id" = s."itemId"
    JOIN vendors v ON v."id" = s."vendorId"
    JOIN purchase_contracts pc ON pc."id" = s."purchaseContractId"
    JOIN companies co ON co."id" = s."companyId"
    WHERE s."companyId" = ${params.companyId}
      AND pc."status" = 'POSTED'
      AND (${params.shipmentId ?? null}::text IS NULL OR s."id" = ${params.shipmentId ?? null})
      AND (${params.from ?? null}::date IS NULL OR pc."contractDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR pc."contractDate" <= ${params.to ?? null}::date)
    ORDER BY s."shipmentNumber" DESC
  `;

  /*
   * The management overhead share, attached beside the accounting figures.
   *
   * The statutory result is untouched: these amounts live in their own table
   * and never reach a journal. They answer "what did this shipment cost once
   * its share of the office is counted?", which the accounts alone cannot.
   */
  const overheads = await getOverheadByShipment({ companyId: params.companyId, from: params.from, to: params.to });
  return rows.map((row) => {
    const shaped = shape(row);
    const allocatedOverheadUsd = toMoney(overheads.get(row.shipmentId) ?? new Decimal(0));
    return {
      ...shaped,
      allocatedOverheadUsd,
      profitAfterOverheadUsd: toMoney(shaped.netProfitUsd.minus(allocatedOverheadUsd)),
    };
  });
}

/**
 * Direct shipment costs summed by category — freight, clearing, transport —
 * for the shipment costing report the client's requirements set out. Only
 * posted expenses, and each one counted once, under the category it was
 * booked to.
 */
export type ShipmentExpenseCategory = {
  shipmentId: string;
  category: string;
  capitalised: boolean;
  amountUsd: Decimal;
  amountLocal: Decimal;
  count: number;
};

export async function getShipmentExpensesByCategory(params: {
  companyId: string;
  shipmentId?: string;
}): Promise<Map<string, ShipmentExpenseCategory[]>> {
  const rows = await prisma.expense.findMany({
    where: {
      companyId: params.companyId,
      status: 'POSTED',
      shipmentId: params.shipmentId ? params.shipmentId : { not: null },
    },
    select: {
      shipmentId: true,
      amountUsd: true,
      amountLocal: true,
      capitaliseToLandedCost: true,
      expenseCategory: { select: { name: true } },
    },
  });

  const byShipment = new Map<string, ShipmentExpenseCategory[]>();
  for (const row of rows) {
    if (!row.shipmentId) continue;
    const list = byShipment.get(row.shipmentId) ?? [];
    const key = `${row.expenseCategory.name}:${row.capitaliseToLandedCost}`;
    const existing = list.find((l) => `${l.category}:${l.capitalised}` === key);
    if (existing) {
      existing.amountUsd = toMoney(existing.amountUsd.plus(row.amountUsd));
      existing.amountLocal = toMoney(existing.amountLocal.plus(row.amountLocal));
      existing.count += 1;
    } else {
      list.push({
        shipmentId: row.shipmentId,
        category: row.expenseCategory.name,
        capitalised: row.capitaliseToLandedCost,
        amountUsd: toMoney(row.amountUsd),
        amountLocal: toMoney(row.amountLocal),
        count: 1,
      });
    }
    byShipment.set(row.shipmentId, list);
  }
  for (const list of byShipment.values()) list.sort((a, b) => a.category.localeCompare(b.category));
  return byShipment;
}

export async function getShipmentProfitabilityById(
  companyId: string,
  shipmentId: string,
): Promise<ShipmentProfitability | null> {
  const rows = await getShipmentProfitability({ companyId, shipmentId });
  return rows[0] ?? null;
}

/** Company-wide totals, used by the dashboard cards and the P&L cross-check. */
export async function getCompanyProfitSummary(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<Array<{ revenue: string; cogs: string; expenses: string; soldKg: string }>>`
    SELECT
      (COALESCE((SELECT SUM(si."subtotalUsd") FROM sales_invoices si
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)), 0)
      - COALESCE((SELECT SUM(cn."subtotalAmountUsd") FROM credit_notes cn
                 WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                   AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS revenue,
      (COALESCE((SELECT SUM(si."costOfGoodsUsd") FROM sales_invoices si
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)), 0)
      - COALESCE((SELECT SUM(cn."costOfGoodsUsd") FROM credit_notes cn
                 WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                   AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS cogs,
      COALESCE((SELECT SUM(e."amountUsd") FROM expenses e
                 WHERE e."companyId" = ${params.companyId} AND e."status" = 'POSTED'
                   AND e."capitaliseToLandedCost" = false
                   AND (${params.from ?? null}::date IS NULL OR e."expenseDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR e."expenseDate" <= ${params.to ?? null}::date)), 0)::text AS expenses,
      (COALESCE((SELECT SUM(sil."quantityKg") FROM sales_invoice_lines sil
                  JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)), 0)
       - COALESCE((SELECT SUM(cnl."quantityKg") FROM credit_note_lines cnl
                    JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                   WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                     AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                     AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS "soldKg"
  `;

  const revenue = toMoney(rows[0]?.revenue ?? 0);
  const cogs = toMoney(rows[0]?.cogs ?? 0);
  const expenses = toMoney(rows[0]?.expenses ?? 0);
  const grossProfit = toMoney(revenue.minus(cogs));
  const netProfit = toMoney(grossProfit.minus(expenses));
  const soldKg = toQuantity(rows[0]?.soldKg ?? 0);

  return {
    revenueUsd: revenue,
    cogsUsd: cogs,
    expensesUsd: expenses,
    grossProfitUsd: grossProfit,
    netProfitUsd: netProfit,
    soldKg,
    profitPerKgUsd: soldKg.greaterThan(0) ? toUnitCost(netProfit.dividedBy(soldKg)) : new Decimal(0),
    grossMarginPct: percentage(grossProfit, revenue),
    netMarginPct: percentage(netProfit, revenue),
  };
}

type BreakdownRow = { key: string; label: string; sublabel: string | null; revenue: string; cogs: string; qty: string };

function shapeBreakdown(rows: BreakdownRow[]) {
  return rows.map((row) => {
    const revenueUsd = toMoney(row.revenue);
    const cogsUsd = toMoney(row.cogs);
    const grossProfitUsd = toMoney(revenueUsd.minus(cogsUsd));
    const quantityKg = toQuantity(row.qty);
    return {
      key: row.key,
      label: row.label,
      sublabel: row.sublabel,
      quantityKg,
      revenueUsd,
      cogsUsd,
      grossProfitUsd,
      grossMarginPct: percentage(grossProfitUsd, revenueUsd),
      profitPerKgUsd: quantityKg.greaterThan(0)
        ? toUnitCost(grossProfitUsd.dividedBy(quantityKg))
        : new Decimal(0),
    };
  });
}

export async function getCustomerProfitability(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<BreakdownRow[]>`
    SELECT c."id" AS key, c."customerName" AS label, c."country" AS sublabel,
           (COALESCE(SUM(sil."lineTotalUsd"), 0)
            - COALESCE((SELECT SUM(cn."subtotalAmountUsd") FROM credit_notes cn
                         WHERE cn."customerId" = c."id" AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                           AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                           AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS revenue,
           (COALESCE(SUM(sil."costTotalUsd"), 0)
            - COALESCE((SELECT SUM(cn."costOfGoodsUsd") FROM credit_notes cn
                         WHERE cn."customerId" = c."id" AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                           AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                           AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS cogs,
           (COALESCE(SUM(sil."quantityKg"), 0)
            - COALESCE((SELECT SUM(cnl."quantityKg") FROM credit_note_lines cnl
                         JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
                        WHERE cn."customerId" = c."id" AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                          AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
                          AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)), 0))::text AS qty
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN customers c ON c."id" = si."customerId"
    WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)
    GROUP BY c."id", c."customerName", c."country"
    ORDER BY SUM(sil."lineTotalUsd") DESC
  `;
  return shapeBreakdown(rows);
}

export async function getProductProfitability(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<BreakdownRow[]>`
    SELECT ci."id" AS key, ci."itemName" AS label, ci."originCountry" AS sublabel,
           COALESCE(SUM(sil."lineTotalUsd"), 0)::text AS revenue,
           COALESCE(SUM(sil."costTotalUsd"), 0)::text AS cogs,
           COALESCE(SUM(sil."quantityKg"), 0)::text   AS qty
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN coffee_items ci ON ci."id" = sil."itemId"
    WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)
    GROUP BY ci."id", ci."itemName", ci."originCountry"
    ORDER BY SUM(sil."lineTotalUsd") DESC
  `;
  return shapeBreakdown(rows);
}

export async function getBatchProfitability(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<BreakdownRow[]>`
    SELECT b."id" AS key, b."batchNumber" AS label, l."lotNumber" AS sublabel,
           COALESCE(SUM(sil."lineTotalUsd"), 0)::text AS revenue,
           COALESCE(SUM(sil."costTotalUsd"), 0)::text AS cogs,
           COALESCE(SUM(sil."quantityKg"), 0)::text   AS qty
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN batches b ON b."id" = sil."batchId"
    JOIN lots l ON l."id" = b."lotId"
    WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)
    GROUP BY b."id", b."batchNumber", l."lotNumber"
    ORDER BY SUM(sil."lineTotalUsd") DESC
  `;
  return shapeBreakdown(rows);
}

export async function getContainerProfitability(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<BreakdownRow[]>`
    SELECT ct."id" AS key, ct."containerNumber" AS label, ct."containerType"::text AS sublabel,
           COALESCE(SUM(sil."lineTotalUsd"), 0)::text AS revenue,
           COALESCE(SUM(sil."costTotalUsd"), 0)::text AS cogs,
           COALESCE(SUM(sil."quantityKg"), 0)::text   AS qty
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN containers ct ON ct."id" = sil."containerId"
    WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)
    GROUP BY ct."id", ct."containerNumber", ct."containerType"
    ORDER BY SUM(sil."lineTotalUsd") DESC
  `;
  return shapeBreakdown(rows);
}

/** Revenue, cost and margin by calendar month — drives the dashboard chart. */
export async function getMonthlyProfitability(params: { companyId: string; months?: number }) {
  const months = params.months ?? 12;
  const rows = await prisma.$queryRaw<
    Array<{ month: string; revenue: string; cogs: string; expenses: string }>
  >`
    WITH period AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${months - 1} || ' months')::interval,
        date_trunc('month', CURRENT_DATE),
        '1 month'
      )::date AS month
    )
    SELECT to_char(p."month", 'YYYY-MM') AS month,
      (COALESCE((SELECT SUM(si."subtotalUsd") FROM sales_invoices si
                  WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                    AND date_trunc('month', si."invoiceDate") = p."month"), 0)
       - COALESCE((SELECT SUM(cn."subtotalAmountUsd") FROM credit_notes cn
                    WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                      AND date_trunc('month', cn."creditDate") = p."month"), 0))::text AS revenue,
      (COALESCE((SELECT SUM(si."costOfGoodsUsd") FROM sales_invoices si
                  WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                    AND date_trunc('month', si."invoiceDate") = p."month"), 0)
       - COALESCE((SELECT SUM(cn."costOfGoodsUsd") FROM credit_notes cn
                    WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
                      AND date_trunc('month', cn."creditDate") = p."month"), 0))::text AS cogs,
      COALESCE((SELECT SUM(e."amountUsd") FROM expenses e
                 WHERE e."companyId" = ${params.companyId} AND e."status" = 'POSTED'
                   AND e."capitaliseToLandedCost" = false
                   AND date_trunc('month', e."expenseDate") = p."month"), 0)::text AS expenses
    FROM period p
    ORDER BY p."month"
  `;

  return rows.map((row) => {
    const revenueUsd = toMoney(row.revenue);
    const cogsUsd = toMoney(row.cogs);
    const expensesUsd = toMoney(row.expenses);
    const grossProfitUsd = toMoney(revenueUsd.minus(cogsUsd));
    return {
      month: row.month,
      revenueUsd,
      cogsUsd,
      expensesUsd,
      grossProfitUsd,
      netProfitUsd: toMoney(grossProfitUsd.minus(expensesUsd)),
    };
  });
}

/** Monthly purchases, for the dashboard's purchases chart. */
export async function getMonthlyPurchases(params: { companyId: string; months?: number }) {
  const months = params.months ?? 12;
  const rows = await prisma.$queryRaw<Array<{ month: string; value: string; qty: string }>>`
    WITH period AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${months - 1} || ' months')::interval,
        date_trunc('month', CURRENT_DATE),
        '1 month'
      )::date AS month
    )
    SELECT to_char(p."month", 'YYYY-MM') AS month,
      COALESCE((SELECT SUM(pc."totalValueUsd") FROM purchase_contracts pc
                 WHERE pc."companyId" = ${params.companyId} AND pc."status" = 'POSTED'
                   AND date_trunc('month', pc."contractDate") = p."month"), 0)::text AS value,
      COALESCE((SELECT SUM(b."orderedQuantityKg") FROM batches b
                 JOIN purchase_contracts pc2 ON pc2."id" = b."purchaseContractId"
                WHERE pc2."companyId" = ${params.companyId} AND pc2."status" = 'POSTED'
                   AND date_trunc('month', pc2."contractDate") = p."month"), 0)::text AS qty
    FROM period p
    ORDER BY p."month"
  `;
  return rows.map((row) => ({
    month: row.month,
    valueUsd: toMoney(row.value),
    quantityKg: toQuantity(row.qty),
  }));
}

export type CogsLine = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerName: string;
  itemName: string;
  batchNumber: string;
  warehouseName: string | null;
  quantityKg: Decimal;
  revenueUsd: Decimal;
  cogsUsd: Decimal;
  grossProfitUsd: Decimal;
  source: 'INVOICE' | 'CREDIT';
};

/** Posted cost of goods sold, line by line, for the named report. */
export async function getCogsReport(params: { companyId: string; from?: Date; to?: Date }): Promise<CogsLine[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      invoiceId: string;
      invoiceNumber: string;
      invoiceDate: Date;
      customerName: string;
      itemName: string;
      batchNumber: string;
      warehouseName: string | null;
      quantityKg: string;
      revenueUsd: string;
      cogsUsd: string;
      source: string;
    }>
  >`
    SELECT * FROM (
      SELECT si."id" AS "invoiceId", si."invoiceNumber", si."invoiceDate",
             c."customerName", ci."itemName", b."batchNumber", w."name" AS "warehouseName",
             sil."quantityKg"::text AS "quantityKg",
             sil."lineTotalUsd"::text AS "revenueUsd",
             sil."costTotalUsd"::text AS "cogsUsd",
             'INVOICE'::text AS source
        FROM sales_invoice_lines sil
        JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
        JOIN customers c ON c."id" = si."customerId"
        JOIN coffee_items ci ON ci."id" = sil."itemId"
        JOIN batches b ON b."id" = sil."batchId"
        LEFT JOIN warehouses w ON w."id" = sil."warehouseId"
       WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
         AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
         AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)
      UNION ALL
      SELECT cn."id" AS "invoiceId", cn."creditNoteNumber" AS "invoiceNumber", cn."creditDate" AS "invoiceDate",
             c."customerName",
             COALESCE(ci."itemName", 'Credit note') AS "itemName",
             COALESCE(b."batchNumber", '—') AS "batchNumber",
             w."name" AS "warehouseName",
             (-cnl."quantityKg")::text AS "quantityKg",
             (-cnl."lineTotalUsd")::text AS "revenueUsd",
             (-cnl."costTotalUsd")::text AS "cogsUsd",
             'CREDIT'::text AS source
        FROM credit_note_lines cnl
        JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
        JOIN customers c ON c."id" = cn."customerId"
        LEFT JOIN coffee_items ci ON ci."id" = cnl."itemId"
        LEFT JOIN batches b ON b."id" = cnl."batchId"
        LEFT JOIN warehouses w ON w."id" = cnl."warehouseId"
       WHERE cn."companyId" = ${params.companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
         AND (cnl."quantityKg" > 0 OR cnl."costTotalUsd" > 0)
         AND (${params.from ?? null}::date IS NULL OR cn."creditDate" >= ${params.from ?? null}::date)
         AND (${params.to ?? null}::date IS NULL OR cn."creditDate" <= ${params.to ?? null}::date)
    ) lines
    ORDER BY "invoiceDate", "invoiceNumber"
  `;

  return rows.map((row) => {
    const revenueUsd = toMoney(row.revenueUsd);
    const cogsUsd = toMoney(row.cogsUsd);
    return {
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      customerName: row.customerName,
      itemName: row.itemName,
      batchNumber: row.batchNumber,
      warehouseName: row.warehouseName,
      quantityKg: toQuantity(row.quantityKg),
      revenueUsd,
      cogsUsd,
      grossProfitUsd: toMoney(revenueUsd.minus(cogsUsd)),
      source: row.source === 'CREDIT' ? 'CREDIT' : 'INVOICE',
    };
  });
}

