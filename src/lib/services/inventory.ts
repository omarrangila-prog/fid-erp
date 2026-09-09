import type { Tx } from '@/lib/db';
import { Decimal, dec, toQuantity, toUnitCost, toMoney } from '@/lib/money';
import { InsufficientStockError, BusinessRuleError, NotFoundError } from '@/lib/errors';
import { getBooleanSetting, SETTING_KEYS } from '@/lib/services/settings';
import type { InventoryTransactionType } from '@prisma/client';

/**
 * The inventory engine.
 *
 * `inventory_transactions` is an append-only movement ledger and is the only
 * authority on stock. Two caches are recomputed from it inside every posting
 * transaction, so neither can drift:
 *
 *   inventory_balances   stock per (batch, warehouse) — "where is it?"
 *   batches.*QuantityKg  stock per batch across warehouses — "how much is there?"
 *
 * Sign convention: `quantityKg` is signed. Goods in are positive, goods out are
 * negative. A reversal is a movement of the same type with the opposite sign,
 * which keeps the ledger append-only while letting the totals net down.
 *
 * Stock states:
 *   ordered     on a purchase contract, not yet received      (batch.orderedQuantityKg)
 *   in transit  ordered − received                            (batch.inTransitQuantityKg)
 *   on hand     physically in a warehouse                     (balance.onHandKg)
 *   reserved    ring-fenced by a draft sale or transfer       (balance.reservedKg)
 *   available   on hand − reserved                            (balance.availableKg)
 *   sold        relieved by a posted sales invoice            (batch.soldQuantityKg)
 *
 * A transfer posts a matched TRANSFER_OUT / TRANSFER_IN pair inside one
 * transaction, so company-level stock is never duplicated and never dips.
 */

/** Movement types that bring goods into the company (not just between sites). */
const INFLOW_TYPES = ['OPENING', 'RECEIPT', 'ADJUSTMENT_IN'] as const;
/** Movement types that only reserve; they never change on-hand stock. */
const RESERVATION_TYPES = ['RESERVATION', 'RESERVATION_RELEASE'] as const;

export type MovementInput = {
  companyId: string;
  batchId: string;
  itemId: string;
  warehouseId: string;
  containerId?: string | null;
  shipmentId?: string | null;
  transactionType: InventoryTransactionType;
  /** Signed: positive brings stock in, negative takes it out. */
  quantityKg: Decimal | string | number;
  bags?: number;
  unitCost?: Decimal | string | number;
  referenceType: string;
  referenceId: string;
  transactionDate: Date;
  notes?: string;
  createdById: string;
};

export type WarehouseBalance = {
  onHandKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  bags: number;
};

export type BatchTotals = {
  orderedQuantityKg: Decimal;
  receivedQuantityKg: Decimal;
  soldQuantityKg: Decimal;
  allocatedQuantityKg: Decimal;
  onHandQuantityKg: Decimal;
  availableQuantityKg: Decimal;
  inTransitQuantityKg: Decimal;
  receivedBags: number;
  soldBags: number;
};

/**
 * Locks a batch row for the rest of the transaction. Every path that consumes
 * stock must call this *before* checking availability, otherwise two concurrent
 * sales could both read the same figure and both pass.
 */
export async function lockBatch(tx: Tx, companyId: string, batchId: string) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; batchNumber: string; itemId: string; shipmentId: string; containerId: string | null }>
  >`
    SELECT "id", "batchNumber", "itemId", "shipmentId", "containerId"
    FROM batches
    WHERE "id" = ${batchId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  const batch = rows[0];
  if (!batch) throw new NotFoundError('Batch');
  return batch;
}

/** Stock for one batch in one warehouse, computed from the movement ledger. */
export async function computeWarehouseBalance(
  tx: Tx,
  batchId: string,
  warehouseId: string,
): Promise<WarehouseBalance> {
  const rows = await tx.$queryRaw<
    Array<{ onHand: string | null; reserved: string | null; bags: string | null }>
  >`
    SELECT
      COALESCE(SUM(CASE WHEN "transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE')
                        THEN "quantityKg" ELSE 0 END), 0)::text AS "onHand",
      COALESCE(SUM(CASE WHEN "transactionType" IN ('RESERVATION','RESERVATION_RELEASE')
                        THEN "quantityKg" ELSE 0 END), 0)::text AS reserved,
      COALESCE(SUM(CASE WHEN "transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE')
                        THEN "bags" ELSE 0 END), 0)::text AS bags
    FROM inventory_transactions
    WHERE "batchId" = ${batchId} AND "warehouseId" = ${warehouseId}
  `;

  const row = rows[0];
  const onHandKg = toQuantity(dec(row?.onHand ?? 0));
  const reservedKg = toQuantity(dec(row?.reserved ?? 0));

  return {
    onHandKg,
    reservedKg,
    availableKg: toQuantity(onHandKg.minus(reservedKg)),
    bags: Number(row?.bags ?? 0),
  };
}

/** Recomputes every derived quantity for a batch across all warehouses. */
export async function computeBatchTotals(tx: Tx, batchId: string): Promise<BatchTotals> {
  const rows = await tx.$queryRaw<
    Array<{
      received: string | null;
      sold: string | null;
      reserved: string | null;
      onHand: string | null;
      receivedBags: string | null;
      soldBags: string | null;
    }>
  >`
    SELECT
      COALESCE(SUM(CASE WHEN "transactionType" IN ('OPENING','RECEIPT','ADJUSTMENT_IN')
                        THEN "quantityKg" ELSE 0 END), 0)::text AS received,
      COALESCE(-SUM(CASE WHEN "transactionType" = 'SALE'
                        THEN "quantityKg" ELSE 0 END), 0)::text AS sold,
      COALESCE(SUM(CASE WHEN "transactionType" IN ('RESERVATION','RESERVATION_RELEASE')
                        THEN "quantityKg" ELSE 0 END), 0)::text AS reserved,
      COALESCE(SUM(CASE WHEN "transactionType" NOT IN ('RESERVATION','RESERVATION_RELEASE')
                        THEN "quantityKg" ELSE 0 END), 0)::text AS "onHand",
      COALESCE(SUM(CASE WHEN "transactionType" IN ('OPENING','RECEIPT','ADJUSTMENT_IN')
                        THEN "bags" ELSE 0 END), 0)::text AS "receivedBags",
      COALESCE(-SUM(CASE WHEN "transactionType" = 'SALE'
                        THEN "bags" ELSE 0 END), 0)::text AS "soldBags"
    FROM inventory_transactions
    WHERE "batchId" = ${batchId}
  `;

  const row = rows[0];
  const batch = await tx.batch.findUniqueOrThrow({
    where: { id: batchId },
    select: { orderedQuantityKg: true },
  });

  const ordered = toQuantity(batch.orderedQuantityKg);
  const received = toQuantity(dec(row?.received ?? 0));
  const sold = toQuantity(dec(row?.sold ?? 0));
  const reserved = toQuantity(dec(row?.reserved ?? 0));
  const onHand = toQuantity(dec(row?.onHand ?? 0));

  return {
    orderedQuantityKg: ordered,
    receivedQuantityKg: received,
    soldQuantityKg: sold,
    allocatedQuantityKg: reserved,
    onHandQuantityKg: onHand,
    availableQuantityKg: toQuantity(onHand.minus(reserved)),
    // Goods that are owned and paid for but have not yet landed anywhere.
    inTransitQuantityKg: toQuantity(Decimal.max(ordered.minus(received), 0)),
    receivedBags: Number(row?.receivedBags ?? 0),
    soldBags: Number(row?.soldBags ?? 0),
  };
}

/** Writes the recomputed per-warehouse balance back to the cache. */
export async function refreshWarehouseBalance(
  tx: Tx,
  params: { companyId: string; batchId: string; warehouseId: string; itemId: string },
): Promise<WarehouseBalance> {
  const balance = await computeWarehouseBalance(tx, params.batchId, params.warehouseId);

  const existing = await tx.inventoryBalance.findUnique({
    where: { batchId_warehouseId: { batchId: params.batchId, warehouseId: params.warehouseId } },
    select: { id: true },
  });

  const data = {
    onHandKg: balance.onHandKg,
    reservedKg: balance.reservedKg,
    availableKg: balance.availableKg,
    bags: balance.bags,
  };

  if (existing) {
    await tx.inventoryBalance.update({ where: { id: existing.id }, data });
  } else {
    await tx.inventoryBalance.create({
      data: {
        companyId: params.companyId,
        batchId: params.batchId,
        warehouseId: params.warehouseId,
        itemId: params.itemId,
        ...data,
      },
    });
  }

  return balance;
}

/** Writes the recomputed batch totals back to the cache. */
export async function refreshBatchCache(tx: Tx, batchId: string): Promise<BatchTotals> {
  const totals = await computeBatchTotals(tx, batchId);
  await tx.batch.update({
    where: { id: batchId },
    data: {
      receivedQuantityKg: totals.receivedQuantityKg,
      soldQuantityKg: totals.soldQuantityKg,
      allocatedQuantityKg: totals.allocatedQuantityKg,
      availableQuantityKg: totals.availableQuantityKg,
      inTransitQuantityKg: totals.inTransitQuantityKg,
      receivedBags: totals.receivedBags,
      soldBags: totals.soldBags,
    },
  });
  return totals;
}

/**
 * Records one stock movement and refreshes both caches. Callers must already
 * hold the batch lock whenever the movement reduces stock.
 */
export async function recordMovement(tx: Tx, input: MovementInput): Promise<BatchTotals> {
  const quantityKg = toQuantity(input.quantityKg);
  if (quantityKg.isZero()) {
    throw new BusinessRuleError('A stock movement must have a non-zero quantity.');
  }

  const unitCost = toUnitCost(input.unitCost ?? 0);

  await tx.inventoryTransaction.create({
    data: {
      companyId: input.companyId,
      itemId: input.itemId,
      shipmentId: input.shipmentId ?? null,
      batchId: input.batchId,
      containerId: input.containerId ?? null,
      warehouseId: input.warehouseId,
      transactionType: input.transactionType,
      quantityKg,
      bags: input.bags ?? 0,
      unitCost,
      valueUsd: toMoney(quantityKg.times(unitCost).abs()),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      transactionDate: input.transactionDate,
      notes: input.notes ?? null,
      createdById: input.createdById,
    },
  });

  await refreshWarehouseBalance(tx, {
    companyId: input.companyId,
    batchId: input.batchId,
    warehouseId: input.warehouseId,
    itemId: input.itemId,
  });

  return refreshBatchCache(tx, input.batchId);
}

/**
 * Availability check shared by every path that takes stock out.
 * Negative stock is refused unless an administrator has explicitly enabled it
 * for the company, in which case the override is audited by the caller.
 */
async function assertSufficient(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    batchNumber: string;
    warehouseId: string;
    requestedKg: Decimal;
    warehouseName?: string;
  },
): Promise<void> {
  const balance = await computeWarehouseBalance(tx, params.batchId, params.warehouseId);
  if (params.requestedKg.lessThanOrEqualTo(balance.availableKg)) return;

  const allowNegative = await getBooleanSetting(tx, params.companyId, SETTING_KEYS.ALLOW_NEGATIVE_STOCK);
  if (allowNegative) return;

  const warehouse =
    params.warehouseName ??
    (await tx.warehouse.findUnique({ where: { id: params.warehouseId }, select: { name: true } }))?.name ??
    'the selected warehouse';

  throw new InsufficientStockError(
    `${params.batchNumber} in ${warehouse}`,
    params.requestedKg.toFixed(3),
    balance.availableKg.toFixed(3),
  );
}

/** Receives goods into a warehouse against a goods receipt note. */
export async function receiveStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    warehouseId: string;
    quantityKg: Decimal | string | number;
    bags?: number;
    unitCostUsd: Decimal | string | number;
    referenceType: string;
    referenceId: string;
    transactionDate: Date;
    createdById: string;
    notes?: string;
  },
): Promise<BatchTotals> {
  const batch = await lockBatch(tx, params.companyId, params.batchId);
  const quantityKg = toQuantity(params.quantityKg);
  if (quantityKg.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('Received quantity must be greater than zero.');
  }

  return recordMovement(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batch.itemId,
    warehouseId: params.warehouseId,
    containerId: batch.containerId,
    shipmentId: batch.shipmentId,
    transactionType: 'RECEIPT',
    quantityKg,
    bags: params.bags ?? 0,
    unitCost: params.unitCostUsd,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    transactionDate: params.transactionDate,
    notes: params.notes,
    createdById: params.createdById,
  });
}

/** Takes stock out of a specific batch in a specific warehouse for a sale. */
export async function consumeStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    warehouseId: string;
    quantityKg: Decimal | string | number;
    bags?: number;
    referenceType: string;
    referenceId: string;
    transactionDate: Date;
    createdById: string;
    notes?: string;
  },
): Promise<{ unitCostUsd: Decimal; totals: BatchTotals }> {
  const batchRow = await lockBatch(tx, params.companyId, params.batchId);
  const quantityKg = toQuantity(params.quantityKg);

  if (quantityKg.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('Sale quantity must be greater than zero.');
  }

  const batch = await tx.batch.findUniqueOrThrow({
    where: { id: params.batchId },
    select: { landedUnitCostUsd: true, unitCostUsd: true, batchNumber: true },
  });

  await assertSufficient(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    batchNumber: batchRow.batchNumber,
    warehouseId: params.warehouseId,
    requestedKg: quantityKg,
  });

  // Cost of goods is taken at landed cost, which already contains freight and
  // the direct shipment charges capitalised against this batch.
  const unitCostUsd = dec(batch.landedUnitCostUsd).greaterThan(0)
    ? dec(batch.landedUnitCostUsd)
    : dec(batch.unitCostUsd);

  const totals = await recordMovement(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batchRow.itemId,
    warehouseId: params.warehouseId,
    containerId: batchRow.containerId,
    shipmentId: batchRow.shipmentId,
    transactionType: 'SALE',
    quantityKg: quantityKg.negated(),
    bags: -(params.bags ?? 0),
    unitCost: unitCostUsd,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    transactionDate: params.transactionDate,
    notes: params.notes,
    createdById: params.createdById,
  });

  return { unitCostUsd, totals };
}

/** Puts stock back when a sale is reversed. */
export async function returnStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    warehouseId: string;
    quantityKg: Decimal | string | number;
    bags?: number;
    unitCostUsd: Decimal | string | number;
    referenceType: string;
    referenceId: string;
    transactionDate: Date;
    createdById: string;
    notes?: string;
  },
): Promise<BatchTotals> {
  const batchRow = await lockBatch(tx, params.companyId, params.batchId);
  return recordMovement(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batchRow.itemId,
    warehouseId: params.warehouseId,
    containerId: batchRow.containerId,
    shipmentId: batchRow.shipmentId,
    transactionType: 'SALE',
    quantityKg: toQuantity(params.quantityKg),
    bags: params.bags ?? 0,
    unitCost: params.unitCostUsd,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    transactionDate: params.transactionDate,
    notes: params.notes ?? 'Sale reversal',
    createdById: params.createdById,
  });
}

/** Ring-fences quantity in a warehouse for a draft sale or an approved transfer. */
export async function reserveStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    warehouseId: string;
    quantityKg: Decimal | string | number;
    referenceType: string;
    referenceId: string;
    transactionDate: Date;
    createdById: string;
  },
): Promise<BatchTotals> {
  const batchRow = await lockBatch(tx, params.companyId, params.batchId);
  const quantityKg = toQuantity(params.quantityKg);

  await assertSufficient(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    batchNumber: batchRow.batchNumber,
    warehouseId: params.warehouseId,
    requestedKg: quantityKg,
  });

  return recordMovement(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batchRow.itemId,
    warehouseId: params.warehouseId,
    containerId: batchRow.containerId,
    shipmentId: batchRow.shipmentId,
    transactionType: 'RESERVATION',
    quantityKg,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    transactionDate: params.transactionDate,
    createdById: params.createdById,
  });
}

/** Releases every reservation held by one reference. */
export async function releaseReservations(
  tx: Tx,
  params: { companyId: string; referenceType: string; referenceId: string; createdById: string; transactionDate: Date },
): Promise<void> {
  const held = await tx.$queryRaw<
    Array<{ batchId: string; itemId: string; warehouseId: string; shipmentId: string | null; net: string }>
  >`
    SELECT "batchId", "itemId", "warehouseId", "shipmentId", SUM("quantityKg")::text AS net
    FROM inventory_transactions
    WHERE "companyId" = ${params.companyId}
      AND "referenceType" = ${params.referenceType}
      AND "referenceId" = ${params.referenceId}
      AND "transactionType" IN ('RESERVATION','RESERVATION_RELEASE')
    GROUP BY "batchId", "itemId", "warehouseId", "shipmentId"
    HAVING SUM("quantityKg") <> 0
  `;

  for (const row of held) {
    await lockBatch(tx, params.companyId, row.batchId);
    await recordMovement(tx, {
      companyId: params.companyId,
      batchId: row.batchId,
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      shipmentId: row.shipmentId,
      transactionType: 'RESERVATION_RELEASE',
      quantityKg: dec(row.net).negated(),
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      transactionDate: params.transactionDate,
      notes: 'Reservation released',
      createdById: params.createdById,
    });
  }
}

/**
 * Moves stock between two warehouses as one atomic pair. Company-level stock is
 * unchanged by construction: the same quantity leaves one site and arrives at
 * the other inside a single transaction.
 */
export async function transferStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantityKg: Decimal | string | number;
    bags?: number;
    referenceType: string;
    referenceId: string;
    transactionDate: Date;
    createdById: string;
    notes?: string;
  },
): Promise<void> {
  if (params.fromWarehouseId === params.toWarehouseId) {
    throw new BusinessRuleError('The source and destination warehouses must be different.');
  }

  const batchRow = await lockBatch(tx, params.companyId, params.batchId);
  const quantityKg = toQuantity(params.quantityKg);
  if (quantityKg.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('Transfer quantity must be greater than zero.');
  }

  const batch = await tx.batch.findUniqueOrThrow({
    where: { id: params.batchId },
    select: { landedUnitCostUsd: true, unitCostUsd: true },
  });
  const unitCost = dec(batch.landedUnitCostUsd).greaterThan(0) ? batch.landedUnitCostUsd : batch.unitCostUsd;

  await assertSufficient(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    batchNumber: batchRow.batchNumber,
    warehouseId: params.fromWarehouseId,
    requestedKg: quantityKg,
  });

  const common = {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batchRow.itemId,
    containerId: batchRow.containerId,
    shipmentId: batchRow.shipmentId,
    unitCost,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    transactionDate: params.transactionDate,
    notes: params.notes,
    createdById: params.createdById,
  };

  await recordMovement(tx, {
    ...common,
    warehouseId: params.fromWarehouseId,
    transactionType: 'TRANSFER_OUT',
    quantityKg: quantityKg.negated(),
    bags: -(params.bags ?? 0),
  });

  await recordMovement(tx, {
    ...common,
    warehouseId: params.toWarehouseId,
    transactionType: 'TRANSFER_IN',
    quantityKg,
    bags: params.bags ?? 0,
  });
}

/** Manual stock correction. Positive brings stock in, negative writes it off. */
export async function adjustStock(
  tx: Tx,
  params: {
    companyId: string;
    batchId: string;
    warehouseId: string;
    quantityKg: Decimal | string | number;
    bags?: number;
    reason: string;
    transactionDate: Date;
    createdById: string;
  },
): Promise<BatchTotals> {
  const batchRow = await lockBatch(tx, params.companyId, params.batchId);
  const quantityKg = toQuantity(params.quantityKg);

  if (quantityKg.isZero()) {
    throw new BusinessRuleError('An adjustment must have a non-zero quantity.');
  }
  if (!params.reason.trim()) {
    throw new BusinessRuleError('A reason is required for every inventory adjustment.');
  }

  const batch = await tx.batch.findUniqueOrThrow({
    where: { id: params.batchId },
    select: { landedUnitCostUsd: true, unitCostUsd: true, batchNumber: true },
  });

  if (quantityKg.isNegative()) {
    await assertSufficient(tx, {
      companyId: params.companyId,
      batchId: params.batchId,
      batchNumber: batch.batchNumber,
      warehouseId: params.warehouseId,
      requestedKg: quantityKg.abs(),
    });
  }

  return recordMovement(tx, {
    companyId: params.companyId,
    batchId: params.batchId,
    itemId: batchRow.itemId,
    warehouseId: params.warehouseId,
    containerId: batchRow.containerId,
    shipmentId: batchRow.shipmentId,
    transactionType: quantityKg.isPositive() ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
    quantityKg,
    bags: params.bags ?? 0,
    unitCost: dec(batch.landedUnitCostUsd).greaterThan(0) ? batch.landedUnitCostUsd : batch.unitCostUsd,
    referenceType: 'INVENTORY_ADJUSTMENT',
    referenceId: params.batchId,
    transactionDate: params.transactionDate,
    notes: params.reason,
    createdById: params.createdById,
  });
}

export { INFLOW_TYPES, RESERVATION_TYPES };
