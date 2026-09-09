import { prisma } from '@/lib/db';
import { Decimal, toMoney, toQuantity, toUnitCost, percentage } from '@/lib/money';

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
  grossProfitUsd: Decimal;
  /** Period costs booked to the job but not capitalised into stock. */
  otherCostsUsd: Decimal;
  netProfitUsd: Decimal;
  profitPerKgUsd: Decimal;
  grossMarginPct: Decimal;
  netMarginPct: Decimal;
};

type RawRow = {
  shipmentId: string;
  shipmentNumber: string;
  jobNumber: string;
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
};

function shape(row: RawRow): ShipmentProfitability {
  const purchaseQuantityKg = toQuantity(row.orderedKg);
  const soldQuantityKg = toQuantity(row.soldKg);
  const goodsCostUsd = toMoney(row.goodsCostUsd);
  const capitalisedCostUsd = toMoney(row.capitalisedCostUsd);
  const totalLandedCostUsd = toMoney(goodsCostUsd.plus(capitalisedCostUsd));
  const allocatedLandedCostUsd = toMoney(row.allocatedLandedCostUsd);
  const salesRevenueUsd = toMoney(row.salesRevenueUsd);
  const otherCostsUsd = toMoney(row.otherCostsUsd);
  const grossProfitUsd = toMoney(salesRevenueUsd.minus(allocatedLandedCostUsd));
  const netProfitUsd = toMoney(grossProfitUsd.minus(otherCostsUsd));

  return {
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipmentNumber,
    jobNumber: row.jobNumber,
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
    grossProfitUsd,
    otherCostsUsd,
    netProfitUsd,
    profitPerKgUsd: soldQuantityKg.greaterThan(0)
      ? toUnitCost(netProfitUsd.dividedBy(soldQuantityKg))
      : new Decimal(0),
    grossMarginPct: percentage(grossProfitUsd, salesRevenueUsd),
    netMarginPct: percentage(netProfitUsd, salesRevenueUsd),
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
      COALESCE((SELECT SUM(si."totalAmountUsd") FROM sales_invoices si
                 WHERE si."shipmentId" = s."id" AND si."status" = 'POSTED'), 0)::text AS "salesRevenueUsd",
      -- Only period costs. Capitalised costs already sit inside landed cost.
      COALESCE((SELECT SUM(e."amountUsd") FROM expenses e
                 WHERE e."shipmentId" = s."id" AND e."status" = 'POSTED'
                   AND e."capitaliseToLandedCost" = false), 0)::text AS "otherCostsUsd"
    FROM shipments s
    JOIN coffee_items ci ON ci."id" = s."itemId"
    JOIN vendors v ON v."id" = s."vendorId"
    JOIN purchase_contracts pc ON pc."id" = s."purchaseContractId"
    WHERE s."companyId" = ${params.companyId}
      AND pc."status" = 'POSTED'
      AND (${params.shipmentId ?? null}::text IS NULL OR s."id" = ${params.shipmentId ?? null})
      AND (${params.from ?? null}::date IS NULL OR pc."contractDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR pc."contractDate" <= ${params.to ?? null}::date)
    ORDER BY s."shipmentNumber" DESC
  `;
  return rows.map(shape);
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
      (COALESCE((SELECT SUM(si."totalAmountUsd") FROM sales_invoices si
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)), 0)
      - COALESCE((SELECT SUM(cn."totalAmountUsd") FROM credit_notes cn
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
      COALESCE((SELECT SUM(sil."quantityKg") FROM sales_invoice_lines sil
                 JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
                WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND (${params.from ?? null}::date IS NULL OR si."invoiceDate" >= ${params.from ?? null}::date)
                   AND (${params.to ?? null}::date IS NULL OR si."invoiceDate" <= ${params.to ?? null}::date)), 0)::text AS "soldKg"
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
           COALESCE(SUM(sil."lineTotalUsd"), 0)::text AS revenue,
           COALESCE(SUM(sil."costTotalUsd"), 0)::text AS cogs,
           COALESCE(SUM(sil."quantityKg"), 0)::text   AS qty
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
      COALESCE((SELECT SUM(si."totalAmountUsd") FROM sales_invoices si
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND date_trunc('month', si."invoiceDate") = p."month"), 0)::text AS revenue,
      COALESCE((SELECT SUM(si."costOfGoodsUsd") FROM sales_invoices si
                 WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'
                   AND date_trunc('month', si."invoiceDate") = p."month"), 0)::text AS cogs,
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
