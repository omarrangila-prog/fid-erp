import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toQuantity, sum } from '@/lib/money';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { reserveStock, releaseReservations, transferStock } from '@/lib/services/inventory';
import { writeAudit } from '@/lib/services/audit';

/**
 * StockTransferService — moving coffee between warehouses.
 *
 * The rule that matters: a transfer changes *where* stock is, never *how much*
 * the company owns. That is guaranteed structurally rather than by discipline:
 *
 *   DRAFT      nothing is touched
 *   APPROVED   the quantity is reserved at the source warehouse, so it can no
 *              longer be sold from there, but it is still company stock
 *   IN_TRANSIT the goods are on the road; the reservation still holds
 *   RECEIVED   one transaction releases the reservation and posts a matched
 *              TRANSFER_OUT / TRANSFER_IN pair
 *
 * Because the out and in movements are written together inside one database
 * transaction, company-level stock never dips while goods are on the road and
 * can never be double-counted at both ends.
 */

export const TRANSFER_STATES = ['DRAFT', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export const TRANSFER_STATE_META: Record<TransferState, { label: string; tone: string }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  APPROVED: { label: 'Approved', tone: 'info' },
  IN_TRANSIT: { label: 'In Transit', tone: 'progress' },
  RECEIVED: { label: 'Received', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

const ALLOWED_TRANSITIONS: Record<TransferState, TransferState[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

export type StockTransferLineInput = {
  batchId: string;
  quantityKg: string | number;
  bags?: number;
  notes?: string | null;
};

export type StockTransferInput = {
  companyId: string;
  transferDate: Date;
  fromWarehouseId: string;
  toWarehouseId: string;
  notes?: string | null;
  lines: StockTransferLineInput[];
};

const REFERENCE_TYPE = 'STOCK_TRANSFER';

async function resolveLines(tx: Tx, input: StockTransferInput) {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A stock transfer needs at least one line.');
  }

  const resolved = [];
  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i];
    const batch = await tx.batch.findFirst({
      where: { id: line.batchId, companyId: input.companyId },
      select: { id: true, batchNumber: true, itemId: true, containerId: true, status: true },
    });
    if (!batch) throw new NotFoundError(`Batch on line ${i + 1}`);
    if (batch.status !== 'ACTIVE') {
      throw new BusinessRuleError(`Batch ${batch.batchNumber} is not active and cannot be transferred.`);
    }

    const quantityKg = toQuantity(line.quantityKg);
    if (quantityKg.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Line ${i + 1}: transfer quantity must be greater than zero.`);
    }

    const balance = await tx.inventoryBalance.findUnique({
      where: { batchId_warehouseId: { batchId: batch.id, warehouseId: input.fromWarehouseId } },
      select: { availableKg: true },
    });
    const available = dec(balance?.availableKg ?? 0);
    if (quantityKg.greaterThan(available)) {
      throw new BusinessRuleError(
        `Batch ${batch.batchNumber} has only ${available.toFixed(3)} KG available in the source warehouse.`,
      );
    }

    resolved.push({
      lineNumber: i + 1,
      batchId: batch.id,
      itemId: batch.itemId,
      containerId: batch.containerId,
      quantityKg,
      bags: line.bags ?? 0,
      notes: line.notes ?? null,
    });
  }
  return resolved;
}

export async function createStockTransfer(input: StockTransferInput, userId: string) {
  return transaction(async (tx) => {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new BusinessRuleError('The source and destination warehouses must be different.');
    }

    for (const id of [input.fromWarehouseId, input.toWarehouseId]) {
      const warehouse = await tx.warehouse.findFirst({
        where: { id, companyId: input.companyId },
        select: { id: true, name: true, status: true },
      });
      if (!warehouse) throw new NotFoundError('Warehouse');
      if (warehouse.status !== 'ACTIVE') {
        throw new BusinessRuleError(`${warehouse.name} is inactive and cannot be used for a transfer.`);
      }
    }

    const lines = await resolveLines(tx, input);
    const transferNumber = await nextReference(tx, { companyId: input.companyId, docType: 'ST' });

    const transfer = await tx.stockTransfer.create({
      data: {
        companyId: input.companyId,
        transferNumber,
        transferDate: input.transferDate,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        status: 'DRAFT',
        workflowState: 'DRAFT',
        notes: input.notes ?? null,
        requestedById: userId,
        lines: {
          create: lines.map((l) => ({
            lineNumber: l.lineNumber,
            batchId: l.batchId,
            itemId: l.itemId,
            containerId: l.containerId,
            quantityKg: l.quantityKg,
            bags: l.bags,
            notes: l.notes,
          })),
        },
      },
      include: { lines: true },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'STOCK_TRANSFER_CREATED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      after: { transferNumber, totalKg: sum(lines.map((l) => l.quantityKg)).toString() },
    });

    return transfer;
  });
}

function assertTransition(from: string, to: TransferState) {
  const allowed = ALLOWED_TRANSITIONS[from as TransferState] ?? [];
  if (!allowed.includes(to)) {
    throw new BusinessRuleError(
      `A transfer cannot move from "${TRANSFER_STATE_META[from as TransferState]?.label ?? from}" to "${TRANSFER_STATE_META[to].label}".`,
    );
  }
}

/** Approving reserves the stock at the source so it cannot also be sold there. */
export async function approveStockTransfer(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({
      where: { id: params.id, companyId: params.companyId },
      include: { lines: true },
    });
    if (!transfer) throw new NotFoundError('Stock transfer');
    assertTransition(transfer.workflowState, 'APPROVED');

    for (const line of transfer.lines) {
      await reserveStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: transfer.fromWarehouseId,
        quantityKg: line.quantityKg,
        referenceType: REFERENCE_TYPE,
        referenceId: transfer.id,
        transactionDate: transfer.transferDate,
        createdById: params.userId,
      });
    }

    const updated = await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { workflowState: 'APPROVED', approvedById: params.userId, approvedAt: new Date() },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_TRANSFER_APPROVED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      before: { workflowState: 'DRAFT' },
      after: { workflowState: 'APPROVED' },
    });

    return updated;
  });
}

export async function dispatchStockTransfer(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({
      where: { id: params.id, companyId: params.companyId },
    });
    if (!transfer) throw new NotFoundError('Stock transfer');
    assertTransition(transfer.workflowState, 'IN_TRANSIT');

    const updated = await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { workflowState: 'IN_TRANSIT' },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_TRANSFER_DISPATCHED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      after: { workflowState: 'IN_TRANSIT' },
    });

    return updated;
  });
}

/**
 * Receiving posts the movement pair. The reservation is released first so the
 * availability check measures real stock rather than counting this transfer
 * against itself.
 */
export async function receiveStockTransfer(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; workflowState: string }>>`
      SELECT "id", "workflowState" FROM stock_transfers
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Stock transfer');
    assertTransition(locked[0].workflowState, 'RECEIVED');

    const transfer = await tx.stockTransfer.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: true, fromWarehouse: true, toWarehouse: true },
    });

    await releaseReservations(tx, {
      companyId: params.companyId,
      referenceType: REFERENCE_TYPE,
      referenceId: transfer.id,
      createdById: params.userId,
      transactionDate: transfer.transferDate,
    });

    for (const line of transfer.lines) {
      await transferStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        fromWarehouseId: transfer.fromWarehouseId,
        toWarehouseId: transfer.toWarehouseId,
        quantityKg: line.quantityKg,
        bags: line.bags,
        referenceType: REFERENCE_TYPE,
        referenceId: transfer.id,
        transactionDate: transfer.transferDate,
        createdById: params.userId,
        notes: `${transfer.transferNumber}: ${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name}`,
      });
    }

    const updated = await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: {
        workflowState: 'RECEIVED',
        status: 'POSTED',
        receivedById: params.userId,
        receivedAt: new Date(),
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_TRANSFER_RECEIVED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      after: {
        workflowState: 'RECEIVED',
        from: transfer.fromWarehouse.name,
        to: transfer.toWarehouse.name,
        totalKg: sum(transfer.lines.map((l) => dec(l.quantityKg))).toString(),
      },
    });

    return updated;
  });
}

export async function cancelStockTransfer(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({
      where: { id: params.id, companyId: params.companyId },
    });
    if (!transfer) throw new NotFoundError('Stock transfer');
    assertTransition(transfer.workflowState, 'CANCELLED');

    await releaseReservations(tx, {
      companyId: params.companyId,
      referenceType: REFERENCE_TYPE,
      referenceId: transfer.id,
      createdById: params.userId,
      transactionDate: new Date(),
    });

    const updated = await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { workflowState: 'CANCELLED', status: 'CANCELLED', cancelledAt: new Date(), notes: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_TRANSFER_CANCELLED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      before: { workflowState: transfer.workflowState },
      after: { workflowState: 'CANCELLED', reason: params.reason },
    });

    return updated;
  });
}

export async function deleteDraftStockTransfer(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!transfer) throw new NotFoundError('Stock transfer');
    if (transfer.workflowState !== 'DRAFT') {
      throw new BusinessRuleError('Only a draft transfer can be deleted. Cancel an approved transfer instead.');
    }
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_TRANSFER_DELETED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      before: { transferNumber: transfer.transferNumber },
    });
    await tx.stockTransfer.delete({ where: { id: params.id } });
  });
}

export type { Decimal };
