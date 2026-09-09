import { prisma } from '@/lib/db';
import { Decimal, toMoney, toQuantity } from '@/lib/money';

/**
 * Stock query service. All figures are read from the batch cache, which the
 * inventory engine recomputes from the movement ledger inside every posting
 * transaction — so the cache is never stale, only faster.
 */

export type StockFilters = {
  companyId: string;
  itemId?: string;
  shipmentId?: string;
  purchaseContractId?: string;
  batchId?: string;
  includeEmpty?: boolean;
};

export type BatchStockRow = {
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  warehouseNames: string;
  orderedKg: Decimal;
  inTransitKg: Decimal;
  itemId: string;
  itemCode: string;
  itemName: string;
  shipmentId: string;
  shipmentNumber: string;
  shipmentStatus: string;
  etaDate: Date | null;
  contractId: string;
  contractNumber: string;
  vendorName: string;
  receivedKg: Decimal;
  allocatedKg: Decimal;
  soldKg: Decimal;
  availableKg: Decimal;
  unitCostUsd: Decimal;
  stockValueUsd: Decimal;
  currency: string;
  status: string;
};

export async function getBatchStock(filters: StockFilters): Promise<BatchStockRow[]> {
  const rows = await prisma.$queryRaw<
    Array<Record<string, string | Date | null>>
  >`
    SELECT b."id" AS "batchId", b."batchNumber", b."status"::text AS status, b."currency",
           l."lotNumber", ct."containerNumber",
           COALESCE((SELECT string_agg(DISTINCT w2."name", ', ')
                       FROM inventory_balances ib2
                       JOIN warehouses w2 ON w2."id" = ib2."warehouseId"
                      WHERE ib2."batchId" = b."id" AND ib2."onHandKg" > 0), '') AS "warehouseNames",
           b."orderedQuantityKg"::text   AS "orderedKg",
           b."inTransitQuantityKg"::text AS "inTransitKg",
           b."receivedQuantityKg"::text  AS "receivedKg",
           b."allocatedQuantityKg"::text AS "allocatedKg",
           b."soldQuantityKg"::text      AS "soldKg",
           b."availableQuantityKg"::text AS "availableKg",
           b."unitCostUsd"::text         AS "unitCostUsd",
           i."id" AS "itemId", i."itemCode", i."itemName",
           s."id" AS "shipmentId", s."shipmentNumber", s."status"::text AS "shipmentStatus", s."etaDate",
           pc."id" AS "contractId", pc."contractNumber",
           v."vendorName"
    FROM batches b
    JOIN coffee_items i ON i."id" = b."itemId"
    JOIN lots l ON l."id" = b."lotId"
    JOIN shipments s ON s."id" = b."shipmentId"
    JOIN purchase_contracts pc ON pc."id" = b."purchaseContractId"
    JOIN vendors v ON v."id" = pc."vendorId"
    LEFT JOIN containers ct ON ct."id" = b."containerId"
    WHERE b."companyId" = ${filters.companyId}
      AND pc."status" = 'POSTED'
      AND (${filters.itemId ?? null}::text IS NULL OR b."itemId" = ${filters.itemId ?? null})
      AND (${filters.shipmentId ?? null}::text IS NULL OR b."shipmentId" = ${filters.shipmentId ?? null})
      AND (${filters.purchaseContractId ?? null}::text IS NULL OR b."purchaseContractId" = ${filters.purchaseContractId ?? null})
      AND (${filters.batchId ?? null}::text IS NULL OR b."id" = ${filters.batchId ?? null})
      AND (${filters.includeEmpty ?? false}::boolean = true OR b."availableQuantityKg" > 0 OR b."receivedQuantityKg" > 0)
    ORDER BY s."shipmentNumber" DESC, b."batchNumber" ASC
  `;

  return rows.map((row) => {
    const availableKg = toQuantity(String(row.availableKg));
    const unitCostUsd = toMoney(String(row.unitCostUsd));
    return {
      batchId: String(row.batchId),
      batchNumber: String(row.batchNumber),
      lotNumber: String(row.lotNumber),
      containerNumber: row.containerNumber ? String(row.containerNumber) : null,
      warehouseNames: String(row.warehouseNames ?? ''),
      orderedKg: toQuantity(String(row.orderedKg)),
      inTransitKg: toQuantity(String(row.inTransitKg)),
      itemId: String(row.itemId),
      itemCode: String(row.itemCode),
      itemName: String(row.itemName),
      shipmentId: String(row.shipmentId),
      shipmentNumber: String(row.shipmentNumber),
      shipmentStatus: String(row.shipmentStatus),
      etaDate: (row.etaDate as Date | null) ?? null,
      contractId: String(row.contractId),
      contractNumber: String(row.contractNumber),
      vendorName: String(row.vendorName),
      receivedKg: toQuantity(String(row.receivedKg)),
      allocatedKg: toQuantity(String(row.allocatedKg)),
      soldKg: toQuantity(String(row.soldKg)),
      availableKg,
      unitCostUsd,
      stockValueUsd: toMoney(availableKg.times(unitCostUsd)),
      currency: String(row.currency),
      status: String(row.status),
    };
  });
}

export type ItemStockRow = {
  itemId: string;
  itemCode: string;
  itemName: string;
  originCountry: string;
  grade: string | null;
  receivedKg: Decimal;
  allocatedKg: Decimal;
  soldKg: Decimal;
  availableKg: Decimal;
  stockValueUsd: Decimal;
  batchCount: number;
};

export async function getItemStock(companyId: string): Promise<ItemStockRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      itemId: string;
      itemCode: string;
      itemName: string;
      originCountry: string;
      grade: string | null;
      receivedKg: string;
      allocatedKg: string;
      soldKg: string;
      availableKg: string;
      stockValueUsd: string;
      batchCount: bigint;
    }>
  >`
    SELECT i."id" AS "itemId", i."itemCode", i."itemName", i."originCountry", i."grade",
           COALESCE(SUM(b."receivedQuantityKg"), 0)::text  AS "receivedKg",
           COALESCE(SUM(b."allocatedQuantityKg"), 0)::text AS "allocatedKg",
           COALESCE(SUM(b."soldQuantityKg"), 0)::text      AS "soldKg",
           COALESCE(SUM(b."availableQuantityKg"), 0)::text AS "availableKg",
           COALESCE(SUM(b."availableQuantityKg" * b."unitCostUsd"), 0)::text AS "stockValueUsd",
           COUNT(b."id") AS "batchCount"
    FROM coffee_items i
    LEFT JOIN batches b ON b."itemId" = i."id"
      AND EXISTS (SELECT 1 FROM purchase_contracts pc WHERE pc."id" = b."purchaseContractId" AND pc."status" = 'POSTED')
    WHERE i."companyId" = ${companyId}
    GROUP BY i."id", i."itemCode", i."itemName", i."originCountry", i."grade"
    ORDER BY i."itemName"
  `;

  return rows.map((row) => ({
    itemId: row.itemId,
    itemCode: row.itemCode,
    itemName: row.itemName,
    originCountry: row.originCountry,
    grade: row.grade,
    receivedKg: toQuantity(row.receivedKg),
    allocatedKg: toQuantity(row.allocatedKg),
    soldKg: toQuantity(row.soldKg),
    availableKg: toQuantity(row.availableKg),
    stockValueUsd: toMoney(row.stockValueUsd),
    batchCount: Number(row.batchCount),
  }));
}

export type ShipmentStockRow = {
  shipmentId: string;
  shipmentNumber: string;
  status: string;
  etaDate: Date | null;
  itemName: string;
  vendorName: string;
  customerName: string | null;
  receivedKg: Decimal;
  allocatedKg: Decimal;
  soldKg: Decimal;
  availableKg: Decimal;
  stockValueUsd: Decimal;
};

export async function getShipmentStock(companyId: string): Promise<ShipmentStockRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      shipmentId: string;
      shipmentNumber: string;
      status: string;
      etaDate: Date | null;
      itemName: string;
      vendorName: string;
      customerName: string | null;
      receivedKg: string;
      allocatedKg: string;
      soldKg: string;
      availableKg: string;
      stockValueUsd: string;
    }>
  >`
    SELECT s."id" AS "shipmentId", s."shipmentNumber", s."status"::text AS status, s."etaDate",
           i."itemName", v."vendorName", c."customerName",
           COALESCE(SUM(b."receivedQuantityKg"), 0)::text  AS "receivedKg",
           COALESCE(SUM(b."allocatedQuantityKg"), 0)::text AS "allocatedKg",
           COALESCE(SUM(b."soldQuantityKg"), 0)::text      AS "soldKg",
           COALESCE(SUM(b."availableQuantityKg"), 0)::text AS "availableKg",
           COALESCE(SUM(b."availableQuantityKg" * b."unitCostUsd"), 0)::text AS "stockValueUsd"
    FROM shipments s
    JOIN coffee_items i ON i."id" = s."itemId"
    JOIN vendors v ON v."id" = s."vendorId"
    JOIN purchase_contracts pc ON pc."id" = s."purchaseContractId"
    LEFT JOIN customers c ON c."id" = s."customerId"
    LEFT JOIN batches b ON b."shipmentId" = s."id"
    WHERE s."companyId" = ${companyId} AND pc."status" = 'POSTED'
    GROUP BY s."id", s."shipmentNumber", s."status", s."etaDate", i."itemName", v."vendorName", c."customerName"
    ORDER BY s."shipmentNumber" DESC
  `;

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipmentNumber,
    status: row.status,
    etaDate: row.etaDate,
    itemName: row.itemName,
    vendorName: row.vendorName,
    customerName: row.customerName,
    receivedKg: toQuantity(row.receivedKg),
    allocatedKg: toQuantity(row.allocatedKg),
    soldKg: toQuantity(row.soldKg),
    availableKg: toQuantity(row.availableKg),
    stockValueUsd: toMoney(row.stockValueUsd),
  }));
}

export type MovementRow = {
  id: string;
  transactionDate: Date;
  transactionType: string;
  quantityKg: Decimal;
  unitCostUsd: Decimal;
  batchNumber: string;
  itemName: string;
  shipmentNumber: string | null;
  referenceType: string;
  referenceId: string;
  referenceLabel: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
};

export async function getStockMovements(params: {
  companyId: string;
  batchId?: string;
  itemId?: string;
  shipmentId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<MovementRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      transactionDate: Date;
      transactionType: string;
      quantityKg: string;
      unitCost: string;
      batchNumber: string;
      itemName: string;
      shipmentNumber: string | null;
      referenceType: string;
      referenceId: string;
      referenceLabel: string | null;
      notes: string | null;
      createdBy: string;
      createdAt: Date;
    }>
  >`
    SELECT it."id", it."transactionDate", it."transactionType"::text AS "transactionType",
           it."quantityKg"::text AS "quantityKg", it."unitCost"::text AS "unitCost",
           b."batchNumber", i."itemName", s."shipmentNumber",
           it."referenceType", it."referenceId",
           CASE
             WHEN it."referenceType" LIKE 'SALES_INVOICE%'     THEN (SELECT si."invoiceNumber"  FROM sales_invoices si     WHERE si."id" = it."referenceId")
             WHEN it."referenceType" LIKE 'PURCHASE_CONTRACT%' THEN (SELECT pc."contractNumber" FROM purchase_contracts pc WHERE pc."id" = it."referenceId")
             ELSE NULL
           END AS "referenceLabel",
           it."notes", u."name" AS "createdBy", it."createdAt"
    FROM inventory_transactions it
    JOIN batches b ON b."id" = it."batchId"
    JOIN coffee_items i ON i."id" = it."itemId"
    JOIN users u ON u."id" = it."createdById"
    LEFT JOIN shipments s ON s."id" = it."shipmentId"
    WHERE it."companyId" = ${params.companyId}
      AND (${params.batchId ?? null}::text IS NULL OR it."batchId" = ${params.batchId ?? null})
      AND (${params.itemId ?? null}::text IS NULL OR it."itemId" = ${params.itemId ?? null})
      AND (${params.shipmentId ?? null}::text IS NULL OR it."shipmentId" = ${params.shipmentId ?? null})
      AND (${params.from ?? null}::date IS NULL OR it."transactionDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR it."transactionDate" <= ${params.to ?? null}::date)
    ORDER BY it."createdAt" DESC
    LIMIT ${params.limit ?? 500}
  `;

  return rows.map((row) => ({
    id: row.id,
    transactionDate: row.transactionDate,
    transactionType: row.transactionType,
    quantityKg: toQuantity(row.quantityKg),
    unitCostUsd: toMoney(row.unitCost),
    batchNumber: row.batchNumber,
    itemName: row.itemName,
    shipmentNumber: row.shipmentNumber,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    referenceLabel: row.referenceLabel,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}

export type SellableStockRow = {
  batchId: string;
  warehouseId: string;
  batchNumber: string;
  lotNumber: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  originCountry: string;
  grade: string | null;
  containerNumber: string | null;
  warehouseName: string;
  warehouseCode: string;
  shipmentId: string;
  shipmentNumber: string;
  availableKg: Decimal;
  bagWeightKg: Decimal;
  landedUnitCostUsd: Decimal;
};

/**
 * Stock that can actually be sold right now: a batch, in a warehouse, with free
 * quantity. A sale must name both, so the picker offers the combination rather
 * than a batch on its own.
 */
export async function getSellableStock(companyId: string): Promise<SellableStockRow[]> {
  const rows = await prisma.$queryRaw<
    Array<Record<string, string | null>>
  >`
    SELECT ib."batchId", ib."warehouseId", b."batchNumber", l."lotNumber",
           ci."id" AS "itemId", ci."itemName", ci."itemCode", ci."originCountry", ci."grade",
           c."containerNumber", w."name" AS "warehouseName", w."code" AS "warehouseCode",
           s."id" AS "shipmentId", s."shipmentNumber",
           ib."availableKg"::text        AS "availableKg",
           b."bagWeightKg"::text         AS "bagWeightKg",
           b."landedUnitCostUsd"::text   AS "landedUnitCostUsd"
    FROM inventory_balances ib
    JOIN batches b ON b."id" = ib."batchId"
    JOIN lots l ON l."id" = b."lotId"
    JOIN coffee_items ci ON ci."id" = b."itemId"
    JOIN warehouses w ON w."id" = ib."warehouseId"
    JOIN shipments s ON s."id" = b."shipmentId"
    LEFT JOIN containers c ON c."id" = b."containerId"
    WHERE ib."companyId" = ${companyId}
      AND b."status" = 'ACTIVE'
      AND ib."availableKg" > 0
    ORDER BY ci."itemName", b."batchNumber", w."name"
  `;

  return rows.map((row) => ({
    batchId: String(row.batchId),
    warehouseId: String(row.warehouseId),
    batchNumber: String(row.batchNumber),
    lotNumber: String(row.lotNumber),
    itemId: String(row.itemId),
    itemName: String(row.itemName),
    itemCode: String(row.itemCode),
    originCountry: String(row.originCountry),
    grade: row.grade,
    containerNumber: row.containerNumber,
    warehouseName: String(row.warehouseName),
    warehouseCode: String(row.warehouseCode),
    shipmentId: String(row.shipmentId),
    shipmentNumber: String(row.shipmentNumber),
    availableKg: toQuantity(String(row.availableKg)),
    bagWeightKg: toQuantity(String(row.bagWeightKg)),
    landedUnitCostUsd: toMoney(String(row.landedUnitCostUsd)),
  }));
}

/** Stock held per warehouse for one batch — the "where is it?" answer. */
export async function getBatchLocations(companyId: string, batchId: string) {
  const rows = await prisma.inventoryBalance.findMany({
    where: { companyId, batchId },
    include: { warehouse: { select: { id: true, name: true, code: true } } },
    orderBy: { warehouse: { name: 'asc' } },
  });

  return rows.map((row) => ({
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    warehouseCode: row.warehouse.code,
    onHandKg: toQuantity(row.onHandKg),
    reservedKg: toQuantity(row.reservedKg),
    availableKg: toQuantity(row.availableKg),
    bags: row.bags,
  }));
}
