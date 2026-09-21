import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity, toUnitCost } from '@/lib/money';
import { bagsForKg, addBags } from '@/lib/bags';

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
  /** The supplier's own reference, e.g. ICUL/FID/002/SCR15-12/6. */
  contractReference: string;
  vendorName: string;
  receivedKg: Decimal;
  allocatedKg: Decimal;
  soldKg: Decimal;
  availableKg: Decimal;
  /** Bags on the shelf: what is in the warehouses (available + allocated) at the batch's bag weight. */
  bags: number;
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
           b."bagWeightKg"::text         AS "bagWeightKg",
           b."unitCostUsd"::text         AS "unitCostUsd",
           i."id" AS "itemId", i."itemCode", i."itemName",
           s."id" AS "shipmentId", s."shipmentNumber", s."status"::text AS "shipmentStatus", s."etaDate",
           pc."id" AS "contractId", pc."contractNumber", pc."contractReference",
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
      contractReference: String(row.contractReference ?? ''),
      vendorName: String(row.vendorName),
      receivedKg: toQuantity(String(row.receivedKg)),
      allocatedKg: toQuantity(String(row.allocatedKg)),
      bags: bagsForKg(availableKg.plus(String(row.allocatedKg)), String(row.bagWeightKg)),
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
  /** The supplier's contract reference — the name the client knows the order by. */
  contractReference: string;
  status: string;
  etaDate: Date | null;
  itemName: string;
  vendorName: string;
  customerName: string | null;
  warehouseNames: string;
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
      contractReference: string;
      status: string;
      etaDate: Date | null;
      itemName: string;
      vendorName: string;
      customerName: string | null;
      warehouseNames: string;
      receivedKg: string;
      allocatedKg: string;
      soldKg: string;
      availableKg: string;
      stockValueUsd: string;
    }>
  >`
    SELECT s."id" AS "shipmentId", s."shipmentNumber", pc."contractReference", s."status"::text AS status, s."etaDate",
           i."itemName", v."vendorName", c."customerName",
           COALESCE((SELECT string_agg(DISTINCT w."name", ', ' ORDER BY w."name")
                       FROM inventory_balances ib
                       JOIN warehouses w ON w."id" = ib."warehouseId"
                       JOIN batches b2 ON b2."id" = ib."batchId"
                      WHERE b2."shipmentId" = s."id" AND ib."onHandKg" > 0), '') AS "warehouseNames",
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
    GROUP BY s."id", s."shipmentNumber", pc."contractReference", s."status", s."etaDate", i."itemName", v."vendorName", c."customerName"
    ORDER BY s."shipmentNumber" DESC
  `;

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipmentNumber,
    contractReference: row.contractReference,
    status: row.status,
    etaDate: row.etaDate,
    itemName: row.itemName,
    vendorName: row.vendorName,
    customerName: row.customerName,
    warehouseNames: String(row.warehouseNames ?? ''),
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
             WHEN it."referenceType" LIKE 'SALES_INVOICE%'     THEN COALESCE(
               (SELECT si."invoiceNumber" FROM sales_invoices si WHERE si."id" = it."referenceId"),
               it."notes"
             )
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
  /** The ICUL/FID order this stock was bought on — its origin, carried through the batch. */
  contractReference: string;
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
           pc."contractReference",
           ib."availableKg"::text        AS "availableKg",
           b."bagWeightKg"::text         AS "bagWeightKg",
           b."landedUnitCostUsd"::text   AS "landedUnitCostUsd"
    FROM inventory_balances ib
    JOIN batches b ON b."id" = ib."batchId"
    JOIN lots l ON l."id" = b."lotId"
    JOIN coffee_items ci ON ci."id" = b."itemId"
    JOIN warehouses w ON w."id" = ib."warehouseId"
    JOIN shipments s ON s."id" = b."shipmentId"
    JOIN purchase_contracts pc ON pc."id" = b."purchaseContractId"
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
    contractReference: String(row.contractReference ?? ''),
    availableKg: toQuantity(String(row.availableKg)),
    bagWeightKg: toQuantity(String(row.bagWeightKg)),
    landedUnitCostUsd: toMoney(String(row.landedUnitCostUsd)),
  }));
}

export type ItemWarehouseLine = {
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  onHandKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  bags: number;
};

export type ItemWarehouseGroup = {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  onHandKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  bags: number;
  lines: ItemWarehouseLine[];
};

export type ItemWarehouseStock = {
  warehouses: ItemWarehouseGroup[];
  totalOnHandKg: Decimal;
  totalReservedKg: Decimal;
  totalAvailableKg: Decimal;
};

type WarehouseMovementRow = {
  itemId: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  onHandKg: string;
  reservedKg: string;
  /** The batch's bag weight; bags are derived from it and the KG, never summed. */
  bagWeightKg: string;
};

/**
 * Physical stock from the movement ledger, with the warehouse cache as a
 * fallback so older receipts still show a location if a cache row exists.
 */
async function loadWarehouseMovements(
  companyId: string,
  itemId?: string,
): Promise<WarehouseMovementRow[]> {
  const [fromLedger, fromCache] = await Promise.all([
    prisma.$queryRaw<WarehouseMovementRow[]>`
      SELECT b."itemId",
             t."warehouseId",
             w."name" AS "warehouseName",
             w."code" AS "warehouseCode",
             t."batchId",
             b."batchNumber",
             l."lotNumber",
             ct."containerNumber",
             COALESCE(SUM(CASE WHEN t."transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE')
                               THEN t."quantityKg" ELSE 0 END), 0)::text AS "onHandKg",
             COALESCE(SUM(CASE WHEN t."transactionType" IN ('RESERVATION','RESERVATION_RELEASE')
                               THEN t."quantityKg" ELSE 0 END), 0)::text AS "reservedKg",
             b."bagWeightKg"::text AS "bagWeightKg"
      FROM inventory_transactions t
      JOIN warehouses w ON w."id" = t."warehouseId"
      JOIN batches b ON b."id" = t."batchId"
      JOIN lots l ON l."id" = b."lotId"
      LEFT JOIN containers ct ON ct."id" = b."containerId"
      WHERE t."companyId" = ${companyId}
        AND (${itemId ?? null}::text IS NULL OR b."itemId" = ${itemId ?? null})
      GROUP BY b."itemId", t."warehouseId", w."name", w."code", t."batchId",
               b."batchNumber", l."lotNumber", ct."containerNumber", b."bagWeightKg"
    `,
    prisma.$queryRaw<WarehouseMovementRow[]>`
      SELECT ib."itemId",
             ib."warehouseId",
             w."name" AS "warehouseName",
             w."code" AS "warehouseCode",
             ib."batchId",
             b."batchNumber",
             l."lotNumber",
             ct."containerNumber",
             ib."onHandKg"::text AS "onHandKg",
             ib."reservedKg"::text AS "reservedKg",
             b."bagWeightKg"::text AS "bagWeightKg"
      FROM inventory_balances ib
      JOIN warehouses w ON w."id" = ib."warehouseId"
      JOIN batches b ON b."id" = ib."batchId"
      JOIN lots l ON l."id" = b."lotId"
      LEFT JOIN containers ct ON ct."id" = b."containerId"
      WHERE ib."companyId" = ${companyId}
        AND (${itemId ?? null}::text IS NULL OR ib."itemId" = ${itemId ?? null})
    `,
  ]);

  const byKey = new Map<string, WarehouseMovementRow>();
  for (const row of fromCache) {
    byKey.set(`${row.itemId}:${row.warehouseId}:${row.batchId}`, row);
  }
  // The ledger is the authority whenever a movement exists for that location.
  for (const row of fromLedger) {
    byKey.set(`${row.itemId}:${row.warehouseId}:${row.batchId}`, row);
  }
  return [...byKey.values()];
}

function emptyWarehouseGroup(
  warehouse: { id: string; name: string; code: string },
): ItemWarehouseGroup {
  return {
    warehouseId: warehouse.id,
    warehouseName: warehouse.name,
    warehouseCode: warehouse.code,
    onHandKg: toQuantity(0),
    reservedKg: toQuantity(0),
    availableKg: toQuantity(0),
    bags: 0,
    lines: [],
  };
}

function applyMovementRow(group: ItemWarehouseGroup, row: WarehouseMovementRow) {
  const onHandKg = toQuantity(row.onHandKg);
  const reservedKg = toQuantity(row.reservedKg);
  const availableKg = toQuantity(onHandKg.minus(reservedKg));
  if (onHandKg.eq(0) && reservedKg.eq(0) && availableKg.eq(0)) return;
  const bags = bagsForKg(onHandKg, row.bagWeightKg);

  group.onHandKg = toQuantity(group.onHandKg.plus(onHandKg));
  group.reservedKg = toQuantity(group.reservedKg.plus(reservedKg));
  group.availableKg = toQuantity(group.availableKg.plus(availableKg));
  group.bags = addBags(group.bags, bags);
  group.lines.push({
    batchId: row.batchId,
    batchNumber: row.batchNumber,
    lotNumber: row.lotNumber,
    containerNumber: row.containerNumber,
    onHandKg,
    reservedKg,
    availableKg,
    bags,
  });
}

function finaliseWarehouseGroups(groups: Map<string, ItemWarehouseGroup>): ItemWarehouseStock {
  const result = [...groups.values()].sort((a, b) =>
    a.warehouseName.localeCompare(b.warehouseName),
  );
  for (const group of result) {
    group.lines.sort((a, b) => a.batchNumber.localeCompare(b.batchNumber));
  }
  return {
    warehouses: result,
    totalOnHandKg: result.reduce((sum, group) => sum.plus(group.onHandKg), dec(0)),
    totalReservedKg: result.reduce((sum, group) => sum.plus(group.reservedKg), dec(0)),
    totalAvailableKg: result.reduce((sum, group) => sum.plus(group.availableKg), dec(0)),
  };
}

/**
 * Live stock of one coffee, split by warehouse, then by batch / lot / container.
 *
 * Opening the item answers "where is it?" before anything else. A sale deducts
 * only the warehouse and batch on the invoice; a transfer moves quantity
 * between warehouses and leaves the company total unchanged.
 */
export async function getItemWarehouseStock(
  companyId: string,
  itemId: string,
): Promise<ItemWarehouseStock> {
  const [warehouses, movements] = await Promise.all([
    prisma.warehouse.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, status: true },
    }),
    loadWarehouseMovements(companyId, itemId),
  ]);

  const groups = new Map<string, ItemWarehouseGroup>();
  for (const warehouse of warehouses) {
    if (warehouse.status !== 'ACTIVE') continue;
    groups.set(warehouse.id, emptyWarehouseGroup(warehouse));
  }

  for (const row of movements) {
    let group = groups.get(row.warehouseId);
    if (!group) {
      group = emptyWarehouseGroup({
        id: row.warehouseId,
        name: row.warehouseName,
        code: row.warehouseCode,
      });
      groups.set(row.warehouseId, group);
    }
    applyMovementRow(group, row);
  }

  return finaliseWarehouseGroups(groups);
}

export type ItemWarehouseListRow = {
  itemId: string;
  warehouses: Array<{ warehouseId: string; warehouseName: string; availableKg: Decimal }>;
  totalAvailableKg: Decimal;
};

/**
 * Warehouse split for every coffee, used on the items list so stock location
 * is visible without opening a second screen.
 */
export async function getWarehouseStockByItem(
  companyId: string,
): Promise<Map<string, ItemWarehouseListRow>> {
  const movements = await loadWarehouseMovements(companyId);
  const byItem = new Map<string, Map<string, { warehouseId: string; warehouseName: string; availableKg: Decimal }>>();

  for (const row of movements) {
    const availableKg = toQuantity(dec(row.onHandKg).minus(row.reservedKg));
    if (availableKg.eq(0) && toQuantity(row.onHandKg).eq(0)) continue;
    let warehouses = byItem.get(row.itemId);
    if (!warehouses) {
      warehouses = new Map();
      byItem.set(row.itemId, warehouses);
    }
    const existing = warehouses.get(row.warehouseId);
    if (existing) {
      existing.availableKg = toQuantity(existing.availableKg.plus(availableKg));
    } else {
      warehouses.set(row.warehouseId, {
        warehouseId: row.warehouseId,
        warehouseName: row.warehouseName,
        availableKg,
      });
    }
  }

  const result = new Map<string, ItemWarehouseListRow>();
  for (const [itemId, warehouses] of byItem) {
    const list = [...warehouses.values()].sort((a, b) =>
      a.warehouseName.localeCompare(b.warehouseName),
    );
    result.set(itemId, {
      itemId,
      warehouses: list,
      totalAvailableKg: list.reduce((sum, row) => sum.plus(row.availableKg), dec(0)),
    });
  }
  return result;
}

export function joinWarehouseNames(names: Iterable<string>): string {
  return [...new Set([...names].flatMap((name) => name.split(',').map((part) => part.trim())))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

/**
 * Warehouse names rolled up for lists: batch, shipment, purchase contract,
 * sales invoice. Used so every operational screen can say where the coffee is.
 */
export async function getWarehouseLabels(companyId: string): Promise<{
  byBatch: Map<string, string>;
  byShipment: Map<string, string>;
  byContract: Map<string, string>;
  byInvoice: Map<string, string>;
  byReceipt: Map<string, string>;
  byPayment: Map<string, string>;
  byExpense: Map<string, string>;
}> {
  const [stockRows, invoiceRows, receiptAllocs, paymentAllocs, expenses] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        batchId: string;
        shipmentId: string;
        purchaseContractId: string;
        warehouseName: string;
      }>
    >`
      SELECT b."id" AS "batchId",
             b."shipmentId",
             b."purchaseContractId",
             w."name" AS "warehouseName"
      FROM inventory_balances ib
      JOIN warehouses w ON w."id" = ib."warehouseId"
      JOIN batches b ON b."id" = ib."batchId"
      WHERE ib."companyId" = ${companyId}
        AND (ib."onHandKg" > 0 OR ib."availableKg" > 0 OR ib."reservedKg" > 0)
    `,
    prisma.$queryRaw<Array<{ invoiceId: string; warehouseName: string }>>`
      SELECT sil."salesInvoiceId" AS "invoiceId", w."name" AS "warehouseName"
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
      JOIN warehouses w ON w."id" = sil."warehouseId"
      WHERE si."companyId" = ${companyId}
    `,
    prisma.receiptAllocation.findMany({
      where: { receipt: { companyId } },
      select: { receiptId: true, salesInvoiceId: true },
    }),
    prisma.paymentAllocation.findMany({
      where: { payment: { companyId } },
      select: { paymentId: true, purchaseContractId: true, expenseId: true },
    }),
    prisma.expense.findMany({
      where: { companyId },
      select: { id: true, shipmentId: true },
    }),
  ]);

  const byBatch = new Map<string, Set<string>>();
  const byShipment = new Map<string, Set<string>>();
  const byContract = new Map<string, Set<string>>();
  const byInvoice = new Map<string, Set<string>>();

  const add = (map: Map<string, Set<string>>, key: string, name: string) => {
    if (!key || !name) return;
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(name);
  };

  for (const row of stockRows) {
    add(byBatch, row.batchId, row.warehouseName);
    add(byShipment, row.shipmentId, row.warehouseName);
    add(byContract, row.purchaseContractId, row.warehouseName);
  }
  for (const row of invoiceRows) {
    add(byInvoice, row.invoiceId, row.warehouseName);
  }

  const collapse = (map: Map<string, Set<string>>) => {
    const out = new Map<string, string>();
    for (const [key, names] of map) out.set(key, joinWarehouseNames(names));
    return out;
  };

  const byBatchOut = collapse(byBatch);
  const byShipmentOut = collapse(byShipment);
  const byContractOut = collapse(byContract);
  const byInvoiceOut = collapse(byInvoice);

  const byExpenseSets = new Map<string, Set<string>>();
  for (const expense of expenses) {
    const label = expense.shipmentId ? byShipmentOut.get(expense.shipmentId) : undefined;
    if (label) {
      for (const name of label.split(', ')) add(byExpenseSets, expense.id, name);
    }
  }
  const byExpenseOut = collapse(byExpenseSets);

  const byReceiptSets = new Map<string, Set<string>>();
  for (const allocation of receiptAllocs) {
    const label = byInvoiceOut.get(allocation.salesInvoiceId);
    if (label) for (const name of label.split(', ')) add(byReceiptSets, allocation.receiptId, name);
  }

  const byPaymentSets = new Map<string, Set<string>>();
  for (const allocation of paymentAllocs) {
    const fromContract = allocation.purchaseContractId
      ? byContractOut.get(allocation.purchaseContractId)
      : undefined;
    const fromExpense = allocation.expenseId ? byExpenseOut.get(allocation.expenseId) : undefined;
    const label = fromContract || fromExpense;
    if (label) for (const name of label.split(', ')) add(byPaymentSets, allocation.paymentId, name);
  }

  return {
    byBatch: byBatchOut,
    byShipment: byShipmentOut,
    byContract: byContractOut,
    byInvoice: byInvoiceOut,
    byReceipt: collapse(byReceiptSets),
    byPayment: collapse(byPaymentSets),
    byExpense: byExpenseOut,
  };
}

/** Stock held per warehouse for one batch — the "where is it?" answer. */
export async function getBatchLocations(companyId: string, batchId: string) {
  const rows = await prisma.inventoryBalance.findMany({
    where: { companyId, batchId },
    include: {
      warehouse: { select: { id: true, name: true, code: true } },
      batch: { select: { bagWeightKg: true } },
    },
    orderBy: { warehouse: { name: 'asc' } },
  });

  return rows.map((row) => ({
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse.name,
    warehouseCode: row.warehouse.code,
    onHandKg: toQuantity(row.onHandKg),
    reservedKg: toQuantity(row.reservedKg),
    availableKg: toQuantity(row.availableKg),
    bags: bagsForKg(row.onHandKg, row.batch.bagWeightKg),
  }));
}

export type StockAgeingRow = {
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  itemName: string;
  originCountry: string;
  warehouseName: string;
  receivedAt: Date | null;
  daysInStock: number | null;
  onHandKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  unitCostUsd: Decimal;
  valueUsd: Decimal;
  /** 0–30, 31–60, 61–90, 91–180, over 180. */
  bucket: string;
};

const AGEING_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'] as const;

function bucketFor(days: number | null): string {
  if (days === null) return 'Not yet received';
  if (days <= 30) return AGEING_BUCKETS[0];
  if (days <= 60) return AGEING_BUCKETS[1];
  if (days <= 90) return AGEING_BUCKETS[2];
  if (days <= 180) return AGEING_BUCKETS[3];
  return AGEING_BUCKETS[4];
}

/**
 * How long each parcel has been sitting.
 *
 * Green coffee is not inert. It loses cup quality over months in a warehouse,
 * and a trader carrying eleven tonnes of last year's crop wants to know before
 * a buyer tells them. Age is counted from the goods receipt — the day it
 * physically landed — not from the contract date, because coffee bought in
 * January and delivered in April has been in the warehouse since April.
 *
 * Reserved quantity is shown beside available, because a parcel that looks old
 * and idle may already be promised to somebody.
 */
export async function getStockAgeing(companyId: string): Promise<StockAgeingRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      batchId: string;
      batchNumber: string;
      lotNumber: string | null;
      containerNumber: string | null;
      itemName: string;
      originCountry: string;
      warehouseName: string;
      receivedAt: Date | null;
      onHandKg: string;
      reservedKg: string;
      unitCostUsd: string;
    }>
  >`
    SELECT b."id" AS "batchId",
           b."batchNumber",
           l."lotNumber",
           c."containerNumber",
           ci."itemName",
           ci."originCountry",
           w."name" AS "warehouseName",
           first_receipt."at" AS "receivedAt",
           ib."onHandKg"::text,
           ib."reservedKg"::text,
           b."landedUnitCostUsd"::text AS "unitCostUsd"
    FROM inventory_balances ib
    JOIN batches b ON b."id" = ib."batchId"
    JOIN warehouses w ON w."id" = ib."warehouseId"
    JOIN coffee_items ci ON ci."id" = b."itemId"
    LEFT JOIN lots l ON l."id" = b."lotId"
    LEFT JOIN containers c ON c."id" = b."containerId"
    LEFT JOIN LATERAL (
      SELECT MIN(t."transactionDate") AS "at"
      FROM inventory_transactions t
      WHERE t."batchId" = ib."batchId"
        AND t."warehouseId" = ib."warehouseId"
        AND t."transactionType" IN ('OPENING', 'RECEIPT')
    ) first_receipt ON true
    WHERE ib."companyId" = ${companyId}
      AND ib."onHandKg" > 0
    ORDER BY first_receipt."at" ASC NULLS LAST, b."batchNumber" ASC`;

  const today = Date.now();

  return rows.map((row) => {
    const onHandKg = toQuantity(row.onHandKg);
    const reservedKg = toQuantity(row.reservedKg);
    const unitCostUsd = dec(row.unitCostUsd);
    const daysInStock = row.receivedAt
      ? Math.max(0, Math.floor((today - row.receivedAt.getTime()) / 86_400_000))
      : null;

    return {
      batchId: row.batchId,
      batchNumber: row.batchNumber,
      lotNumber: row.lotNumber ?? '—',
      containerNumber: row.containerNumber,
      itemName: row.itemName,
      originCountry: row.originCountry,
      warehouseName: row.warehouseName,
      receivedAt: row.receivedAt,
      daysInStock,
      onHandKg,
      reservedKg,
      availableKg: toQuantity(onHandKg.minus(reservedKg)),
      unitCostUsd,
      valueUsd: toMoney(onHandKg.times(unitCostUsd)),
      bucket: bucketFor(daysInStock),
    };
  });
}

/** The ageing buckets in order, so a summary can show empty ones too. */
export const STOCK_AGEING_BUCKETS = AGEING_BUCKETS;

export type InventoryValuationLine = {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  itemId: string;
  itemName: string;
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  onHandKg: Decimal;
  availableKg: Decimal;
  landedUnitCostUsd: Decimal;
  valueUsd: Decimal;
};

/** On-hand stock at landed cost, warehouse then batch. */
export async function getInventoryValuation(companyId: string): Promise<InventoryValuationLine[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      warehouseId: string;
      warehouseName: string;
      warehouseCode: string;
      itemId: string;
      itemName: string;
      batchId: string;
      batchNumber: string;
      lotNumber: string;
      containerNumber: string | null;
      onHandKg: string;
      availableKg: string;
      landedUnitCostUsd: string;
    }>
  >`
    SELECT w."id" AS "warehouseId", w."name" AS "warehouseName", w."code" AS "warehouseCode",
           ci."id" AS "itemId", ci."itemName",
           b."id" AS "batchId", b."batchNumber", l."lotNumber", c."containerNumber",
           ib."onHandKg"::text AS "onHandKg",
           ib."availableKg"::text AS "availableKg",
           b."landedUnitCostUsd"::text AS "landedUnitCostUsd"
      FROM inventory_balances ib
      JOIN warehouses w ON w."id" = ib."warehouseId"
      JOIN batches b ON b."id" = ib."batchId"
      JOIN lots l ON l."id" = b."lotId"
      JOIN coffee_items ci ON ci."id" = b."itemId"
      LEFT JOIN containers c ON c."id" = b."containerId"
     WHERE ib."companyId" = ${companyId} AND ib."onHandKg" > 0
     ORDER BY w."name", ci."itemName", b."batchNumber"
  `;

  return rows.map((row) => {
    const onHandKg = toQuantity(row.onHandKg);
    // The unit cost keeps its four places: rounding it to cents before
    // multiplying by twelve tonnes left the shelf a quarter off the ledger.
    const landedUnitCostUsd = toUnitCost(row.landedUnitCostUsd);
    return {
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName,
      warehouseCode: row.warehouseCode,
      itemId: row.itemId,
      itemName: row.itemName,
      batchId: row.batchId,
      batchNumber: row.batchNumber,
      lotNumber: row.lotNumber,
      containerNumber: row.containerNumber,
      onHandKg,
      availableKg: toQuantity(row.availableKg),
      landedUnitCostUsd,
      valueUsd: toMoney(onHandKg.times(landedUnitCostUsd)),
    };
  });
}


export type StockMovementSummaryRow = {
  itemId: string;
  itemName: string;
  warehouseId: string | null;
  warehouseName: string;
  openingKg: Decimal;
  receiptsKg: Decimal;
  transfersInKg: Decimal;
  transfersOutKg: Decimal;
  salesKg: Decimal;
  adjustmentsKg: Decimal;
  closingKg: Decimal;
  closingValueUsd: Decimal;
};

/**
 * Opening stock, what moved, closing stock — for a day or any range.
 *
 * The warehouse keeper's question is not "what happened" but "does what I
 * have agree with what the system says I should have". So the report opens
 * with the balance carried in, lists the movements in the categories that
 * actually occur — received, transferred in, transferred out, sold,
 * adjusted — and closes with the balance carried out. Opening plus movements
 * equals closing, or the figures are wrong and it shows.
 *
 * Reservations are deliberately left out: reserving coffee for a draft
 * invoice does not move it, and counting it here would make the closing
 * balance disagree with the shelf.
 */
export async function getStockMovementSummary(params: {
  companyId: string;
  from: Date;
  to: Date;
  warehouseId?: string;
  itemId?: string;
}): Promise<StockMovementSummaryRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      itemId: string;
      itemName: string;
      warehouseId: string | null;
      warehouseName: string | null;
      openingKg: string;
      receiptsKg: string;
      transfersInKg: string;
      transfersOutKg: string;
      salesKg: string;
      adjustmentsKg: string;
      closingKg: string;
      closingValueUsd: string;
    }>
  >`
    SELECT it."itemId", ci."itemName", it."warehouseId", w."name" AS "warehouseName",
           COALESCE(SUM(CASE WHEN it."transactionDate" < ${params.from}::date
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "openingKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" BETWEEN ${params.from}::date AND ${params.to}::date
                              AND it."transactionType" IN ('RECEIPT', 'OPENING')
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "receiptsKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" BETWEEN ${params.from}::date AND ${params.to}::date
                              AND it."transactionType" = 'TRANSFER_IN'
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "transfersInKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" BETWEEN ${params.from}::date AND ${params.to}::date
                              AND it."transactionType" = 'TRANSFER_OUT'
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "transfersOutKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" BETWEEN ${params.from}::date AND ${params.to}::date
                              AND it."transactionType" = 'SALE'
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "salesKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" BETWEEN ${params.from}::date AND ${params.to}::date
                              AND it."transactionType" IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL')
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "adjustmentsKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" <= ${params.to}::date
                             THEN it."quantityKg" ELSE 0 END), 0)::text AS "closingKg",
           COALESCE(SUM(CASE WHEN it."transactionDate" <= ${params.to}::date
                             THEN it."quantityKg" * it."unitCost" ELSE 0 END), 0)::text AS "closingValueUsd"
      FROM inventory_transactions it
      JOIN coffee_items ci ON ci."id" = it."itemId"
      LEFT JOIN warehouses w ON w."id" = it."warehouseId"
     WHERE it."companyId" = ${params.companyId}
       -- Reserving coffee for a draft invoice does not move it off the shelf.
       AND it."transactionType" NOT IN ('RESERVATION', 'RESERVATION_RELEASE')
       AND it."transactionDate" <= ${params.to}::date
       AND (${params.warehouseId ?? null}::text IS NULL OR it."warehouseId" = ${params.warehouseId ?? null})
       AND (${params.itemId ?? null}::text IS NULL OR it."itemId" = ${params.itemId ?? null})
     GROUP BY it."itemId", ci."itemName", it."warehouseId", w."name"
     ORDER BY ci."itemName", w."name"
  `;

  return rows
    .map((row) => ({
      itemId: row.itemId,
      itemName: row.itemName,
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName ?? 'Not in a warehouse',
      openingKg: toQuantity(row.openingKg),
      receiptsKg: toQuantity(row.receiptsKg),
      transfersInKg: toQuantity(row.transfersInKg),
      transfersOutKg: toQuantity(row.transfersOutKg),
      salesKg: toQuantity(row.salesKg),
      adjustmentsKg: toQuantity(row.adjustmentsKg),
      closingKg: toQuantity(row.closingKg),
      closingValueUsd: toMoney(row.closingValueUsd),
    }))
    .filter(
      (row) =>
        !row.openingKg.isZero() ||
        !row.closingKg.isZero() ||
        !row.receiptsKg.isZero() ||
        !row.salesKg.isZero() ||
        !row.transfersInKg.isZero() ||
        !row.transfersOutKg.isZero() ||
        !row.adjustmentsKg.isZero(),
    );
}

// ---------------------------------------------------------------------------
// Inventory valuation, summary by item and detail by movement
// ---------------------------------------------------------------------------

export type ValuationSummaryRow = {
  itemId: string;
  itemName: string;
  onHandKg: Decimal;
  /** Value ÷ quantity: the average landed cost of what is on the shelf. */
  averageCostUsd: Decimal;
  assetValueUsd: Decimal;
  batches: number;
};

/** Item · quantity · average landed cost · asset value — the concise view. */
export async function getInventoryValuationSummary(companyId: string): Promise<ValuationSummaryRow[]> {
  const lines = await getInventoryValuation(companyId);
  const byItem = new Map<string, ValuationSummaryRow & { batchIds: Set<string> }>();
  for (const line of lines) {
    const row =
      byItem.get(line.itemId) ??
      { itemId: line.itemId, itemName: line.itemName, onHandKg: new Decimal(0), averageCostUsd: new Decimal(0), assetValueUsd: new Decimal(0), batches: 0, batchIds: new Set<string>() };
    row.onHandKg = row.onHandKg.plus(line.onHandKg);
    row.assetValueUsd = row.assetValueUsd.plus(line.valueUsd);
    row.batchIds.add(line.batchId);
    byItem.set(line.itemId, row);
  }
  return [...byItem.values()]
    .map(({ batchIds, ...row }) => ({
      ...row,
      batches: batchIds.size,
      onHandKg: toQuantity(row.onHandKg),
      assetValueUsd: toMoney(row.assetValueUsd),
      averageCostUsd: row.onHandKg.greaterThan(0) ? toUnitCost(row.assetValueUsd.dividedBy(row.onHandKg)) : new Decimal(0),
    }))
    .filter((row) => !row.onHandKg.isZero() || !row.assetValueUsd.isZero())
    .sort((a, b) => a.itemName.localeCompare(b.itemName));
}

export type ValuationDetailMovement = {
  id: string;
  date: Date;
  type: string;
  referenceType: string;
  referenceId: string;
  warehouseName: string | null;
  quantityKg: Decimal;
  unitCostUsd: Decimal;
  costUsd: Decimal;
  onHandAfterKg: Decimal;
  valueAfterUsd: Decimal;
};

export type ValuationDetailGroup = {
  itemId: string;
  itemName: string;
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  shipmentReference: string | null;
  movements: ValuationDetailMovement[];
  closingKg: Decimal;
  closingValueUsd: Decimal;
};

/**
 * Every movement that changed quantity or value, batch by batch, with the
 * quantity on hand and asset value after each — the detail behind the
 * summary. Reservations are not movements and are left out.
 */
export async function getInventoryValuationDetail(params: { companyId: string; from?: Date; to?: Date }): Promise<ValuationDetailGroup[]> {
  const rows = await prisma.inventoryTransaction.findMany({
    where: {
      companyId: params.companyId,
      transactionType: { notIn: ['RESERVATION', 'RESERVATION_RELEASE'] },
      ...(params.to ? { transactionDate: { lte: params.to } } : {}),
    },
    orderBy: [{ batchId: 'asc' }, { transactionDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      transactionDate: true,
      transactionType: true,
      referenceType: true,
      referenceId: true,
      quantityKg: true,
      unitCost: true,
      warehouse: { select: { name: true } },
      batch: {
        select: {
          id: true,
          batchNumber: true,
          itemId: true,
          landedUnitCostUsd: true,
          shipmentId: true,
          item: { select: { itemName: true } },
          lot: { select: { lotNumber: true } },
          container: { select: { containerNumber: true } },
          shipment: { select: { purchaseContract: { select: { contractReference: true } } } },
        },
      },
    },
  });

  /*
   * A cost capitalised after the coffee landed — a late clearing invoice, a
   * freight bill that came in a month on — raises the value of what is on
   * the shelf without moving a kilogram, so it has no stock movement of its
   * own. It is shown as a cost adjustment on the batch, dated by the latest
   * such expense on its shipment, so the value after the last line is the
   * value the balance sheet carries.
   */
  const lateCosts = await prisma.expense.groupBy({
    by: ['shipmentId'],
    where: {
      companyId: params.companyId,
      status: 'POSTED',
      capitaliseToLandedCost: true,
      shipmentId: { not: null },
      ...(params.to ? { expenseDate: { lte: params.to } } : {}),
    },
    _max: { expenseDate: true },
  });
  const lateCostDate = new Map(lateCosts.map((e) => [e.shipmentId as string, e._max.expenseDate as Date]));
  const latestLanded = new Map<string, { onHandKg: Decimal; unitCost: Decimal; shipmentId: string | null }>();

  const groups = new Map<string, ValuationDetailGroup & { runningKg: Decimal; runningValue: Decimal }>();
  for (const row of rows) {
    const g =
      groups.get(row.batch.id) ??
      {
        itemId: row.batch.itemId,
        itemName: row.batch.item.itemName,
        batchId: row.batch.id,
        batchNumber: row.batch.batchNumber,
        lotNumber: row.batch.lot.lotNumber,
        containerNumber: row.batch.container?.containerNumber ?? null,
        shipmentReference: row.batch.shipment?.purchaseContract.contractReference ?? null,
        movements: [],
        closingKg: new Decimal(0),
        closingValueUsd: new Decimal(0),
        runningKg: new Decimal(0),
        runningValue: new Decimal(0),
      };
    const qty = dec(row.quantityKg);
    const cost = toMoney(qty.times(row.unitCost));
    g.runningKg = g.runningKg.plus(qty);
    g.runningValue = g.runningValue.plus(cost);
    // Movements before the period are folded into the opening position; the
    // ones inside it are listed.
    if (!params.from || row.transactionDate >= params.from) {
      g.movements.push({
        id: row.id,
        date: row.transactionDate,
        type: row.transactionType,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        warehouseName: row.warehouse?.name ?? null,
        quantityKg: toQuantity(qty),
        unitCostUsd: toUnitCost(row.unitCost),
        costUsd: cost,
        onHandAfterKg: toQuantity(g.runningKg),
        valueAfterUsd: toMoney(g.runningValue),
      });
    }
    groups.set(row.batch.id, g);
    latestLanded.set(row.batch.id, { onHandKg: g.runningKg, unitCost: dec(row.batch.landedUnitCostUsd), shipmentId: row.batch.shipmentId });
  }

  // Close each batch at on hand × its landed unit cost — the valuation basis —
  // and show the difference from the movements as the cost adjustment it is.
  if (!params.to) {
    for (const g of groups.values()) {
      const landed = latestLanded.get(g.batchId)!;
      const carried = toMoney(landed.onHandKg.times(landed.unitCost));
      const adjustment = toMoney(carried.minus(g.runningValue));
      // A batch sold out carries nothing: whatever the movements leave behind
      // is the true-up that went to cost of sales, and is shown leaving.
      if (adjustment.isZero()) continue;
      const lastMovement = g.movements.at(-1)?.date ?? params.from ?? new Date();
      const expenseDate = landed.shipmentId ? lateCostDate.get(landed.shipmentId) : undefined;
      const date = expenseDate && expenseDate > lastMovement ? expenseDate : lastMovement;
      g.runningValue = carried;
      if (!params.from || date >= params.from) {
        g.movements.push({
          id: `${g.batchId}:landed-cost`,
          date,
          type: 'LANDED_COST_ADJUSTMENT',
          referenceType: 'LandedCost',
          referenceId: '',
          warehouseName: null,
          quantityKg: new Decimal(0),
          unitCostUsd: new Decimal(0),
          costUsd: adjustment,
          onHandAfterKg: toQuantity(g.runningKg),
          valueAfterUsd: carried,
        });
      }
    }
  }

  return [...groups.values()]
    .map(({ runningKg, runningValue, ...g }) => ({ ...g, closingKg: toQuantity(runningKg), closingValueUsd: toMoney(runningValue) }))
    .filter((g) => g.movements.length > 0 || !g.closingKg.isZero())
    .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.batchNumber.localeCompare(b.batchNumber));
}
