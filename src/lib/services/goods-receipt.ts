import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity, sum } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { receiveStock, recordMovement, lockBatch } from '@/lib/services/inventory';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';

/**
 * GoodsReceiptService.
 *
 * Approving a purchase order creates the supplier liability and puts the coffee
 * into "Inventory in Transit". It does not put a single kilogram into a
 * warehouse. This service is the event that does:
 *
 *   Dr Inventory — Coffee Stock      (at the batch's landed cost)
 *   Cr Inventory in Transit
 *
 * and posts the RECEIPT stock movements that make the coffee sellable.
 *
 * A purchase order can be received in as many partial receipts as reality
 * requires; each receipt names the warehouse the coffee physically went into,
 * and over-receipt against the ordered quantity is refused.
 */

export type GoodsReceiptLineInput = {
  batchId: string;
  quantityKg: string | number;
  bags?: number;
  notes?: string | null;
};

export type GoodsReceiptInput = {
  companyId: string;
  purchaseContractId: string;
  warehouseId: string;
  receiptDate: Date;
  receivedById: string;
  reference?: string | null;
  notes?: string | null;
  lines: GoodsReceiptLineInput[];
};

type ResolvedGrnLine = {
  lineNumber: number;
  batchId: string;
  itemId: string;
  containerId: string | null;
  contractLineId: string;
  batchNumber: string;
  quantityKg: Decimal;
  bags: number;
  landedUnitCostUsd: Decimal;
  notes: string | null;
};

async function resolveLines(tx: Tx, input: GoodsReceiptInput): Promise<ResolvedGrnLine[]> {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A goods receipt needs at least one line.');
  }

  const resolved: ResolvedGrnLine[] = [];

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i];
    const batch = await tx.batch.findFirst({
      where: { id: line.batchId, companyId: input.companyId, purchaseContractId: input.purchaseContractId },
      select: {
        id: true,
        batchNumber: true,
        itemId: true,
        containerId: true,
        purchaseContractLineId: true,
        orderedQuantityKg: true,
        receivedQuantityKg: true,
        landedUnitCostUsd: true,
        unitCostUsd: true,
        status: true,
      },
    });
    if (!batch) throw new NotFoundError(`Batch on line ${i + 1}`);
    if (batch.status !== 'ACTIVE') {
      throw new BusinessRuleError(`Batch ${batch.batchNumber} is not active and cannot be received.`);
    }
    if (!batch.purchaseContractLineId) {
      throw new BusinessRuleError(`Batch ${batch.batchNumber} is not linked to a contract line.`);
    }

    const quantityKg = toQuantity(line.quantityKg);
    if (quantityKg.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Line ${i + 1}: received quantity must be greater than zero.`);
    }

    const outstanding = toQuantity(dec(batch.orderedQuantityKg).minus(dec(batch.receivedQuantityKg)));
    if (quantityKg.greaterThan(outstanding)) {
      throw new BusinessRuleError(
        `Batch ${batch.batchNumber}: only ${outstanding.toFixed(3)} KG is still to be received, but ${quantityKg.toFixed(3)} KG was entered.`,
      );
    }

    resolved.push({
      lineNumber: i + 1,
      batchId: batch.id,
      itemId: batch.itemId,
      containerId: batch.containerId,
      contractLineId: batch.purchaseContractLineId,
      batchNumber: batch.batchNumber,
      quantityKg,
      bags: line.bags ?? 0,
      landedUnitCostUsd: dec(batch.landedUnitCostUsd).greaterThan(0)
        ? dec(batch.landedUnitCostUsd)
        : dec(batch.unitCostUsd),
      notes: line.notes ?? null,
    });
  }

  return resolved;
}

export async function createGoodsReceipt(input: GoodsReceiptInput, userId: string) {
  return transaction(async (tx) => {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: input.purchaseContractId, companyId: input.companyId },
      include: { shipments: { select: { id: true } } },
    });
    if (!contract) throw new NotFoundError('Purchase contract');
    if (contract.status !== 'POSTED') {
      throw new BusinessRuleError('Goods can only be received against an approved purchase contract.');
    }

    const warehouse = await tx.warehouse.findFirst({
      where: { id: input.warehouseId, companyId: input.companyId },
      select: { id: true, name: true, status: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse');
    if (warehouse.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${warehouse.name} is inactive and cannot receive stock.`);
    }

    const lines = await resolveLines(tx, input);
    const grnNumber = await nextReference(tx, { companyId: input.companyId, docType: 'GRN' });

    const receipt = await tx.goodsReceipt.create({
      data: {
        companyId: input.companyId,
        grnNumber,
        receiptDate: input.receiptDate,
        purchaseContractId: contract.id,
        shipmentId: contract.shipments[0]?.id ?? null,
        vendorId: contract.vendorId,
        warehouseId: input.warehouseId,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'DRAFT',
        receivedById: input.receivedById,
        createdById: userId,
        lines: {
          create: lines.map((l) => ({
            lineNumber: l.lineNumber,
            purchaseContractLineId: l.contractLineId,
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
      action: 'GOODS_RECEIPT_CREATED',
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      after: {
        grnNumber,
        warehouse: warehouse.name,
        contract: contract.contractNumber,
        totalKg: sum(lines.map((l) => l.quantityKg)).toString(),
      },
    });

    return receipt;
  });
}

export async function postGoodsReceipt(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM goods_receipts
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Goods receipt');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(`This goods receipt is already ${locked[0].status.toLowerCase()}.`);
    }

    const receipt = await tx.goodsReceipt.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        lines: { orderBy: { lineNumber: 'asc' }, include: { batch: true } },
        warehouse: true,
        purchaseContract: true,
      },
    });

    const company = await getCompanyContext(tx, params.companyId);
    let receivedValueUsd = new Decimal(0);

    for (const line of receipt.lines) {
      const batch = line.batch;
      const outstanding = toQuantity(dec(batch.orderedQuantityKg).minus(dec(batch.receivedQuantityKg)));
      if (dec(line.quantityKg).greaterThan(outstanding)) {
        throw new BusinessRuleError(
          `Batch ${batch.batchNumber} now has only ${outstanding.toFixed(3)} KG outstanding, which is less than the ${dec(line.quantityKg).toFixed(3)} KG on this receipt.`,
        );
      }

      const unitCostUsd = dec(batch.landedUnitCostUsd).greaterThan(0)
        ? dec(batch.landedUnitCostUsd)
        : dec(batch.unitCostUsd);

      await receiveStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: receipt.warehouseId,
        quantityKg: line.quantityKg,
        bags: line.bags,
        unitCostUsd,
        referenceType: 'GOODS_RECEIPT',
        referenceId: receipt.id,
        transactionDate: receipt.receiptDate,
        createdById: params.userId,
        notes: `Received into ${receipt.warehouse.name} on ${receipt.grnNumber}`,
      });

      // Record the warehouse on the batch as its primary location hint.
      if (!batch.warehouseId) {
        await tx.batch.update({ where: { id: batch.id }, data: { warehouseId: receipt.warehouseId } });
      }

      receivedValueUsd = receivedValueUsd.plus(toMoney(dec(line.quantityKg).times(unitCostUsd)));
    }

    receivedValueUsd = toMoney(receivedValueUsd);

    // The goods move from "in transit" to warehouse stock. Both sides are in
    // USD because inventory is carried in the group currency.
    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: receipt.receiptDate,
      description: `Goods receipt ${receipt.grnNumber} into ${receipt.warehouse.name}`,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: receipt.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: receipt.purchaseContract.rateLocalPerUsd,
      lines: [
        {
          accountKey: ACCOUNT_KEYS.INVENTORY,
          direction: 'DEBIT',
          currency: 'USD',
          amount: receivedValueUsd,
          rateToUsd: 1,
          description: `Coffee received into ${receipt.warehouse.name}`,
          purchaseContractId: receipt.purchaseContractId,
          shipmentId: receipt.shipmentId,
          vendorId: receipt.vendorId,
        },
        {
          accountKey: ACCOUNT_KEYS.INVENTORY_IN_TRANSIT,
          direction: 'CREDIT',
          currency: 'USD',
          amount: receivedValueUsd,
          rateToUsd: 1,
          description: 'Cleared from goods in transit',
          purchaseContractId: receipt.purchaseContractId,
          shipmentId: receipt.shipmentId,
          vendorId: receipt.vendorId,
        },
      ],
    });

    const posted = await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: { status: 'POSTED', postedAt: new Date() },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'GOODS_RECEIPT_POSTED',
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      before: { status: 'DRAFT' },
      after: { status: 'POSTED', warehouse: receipt.warehouse.name, valueUsd: receivedValueUsd },
    });

    return posted;
  });
}

export async function reverseGoodsReceipt(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM goods_receipts
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Goods receipt');
    if (locked[0].status !== 'POSTED') throw new BusinessRuleError('Only a posted goods receipt can be reversed.');

    const receipt = await tx.goodsReceipt.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: { include: { batch: true } }, warehouse: true },
    });

    const reversalDate = new Date();

    for (const line of receipt.lines) {
      await lockBatch(tx, params.companyId, line.batchId);
      const balance = await tx.inventoryBalance.findUnique({
        where: { batchId_warehouseId: { batchId: line.batchId, warehouseId: receipt.warehouseId } },
        select: { availableKg: true },
      });
      if (!balance || dec(balance.availableKg).lessThan(dec(line.quantityKg))) {
        throw new BusinessRuleError(
          `Batch ${line.batch.batchNumber} no longer has ${dec(line.quantityKg).toFixed(3)} KG available in ${receipt.warehouse.name}. Reverse the sales or transfers that used it first.`,
        );
      }

      await recordMovement(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        itemId: line.itemId,
        warehouseId: receipt.warehouseId,
        containerId: line.containerId,
        shipmentId: receipt.shipmentId,
        transactionType: 'RECEIPT',
        quantityKg: dec(line.quantityKg).negated(),
        bags: -line.bags,
        unitCost: line.batch.landedUnitCostUsd,
        referenceType: 'GOODS_RECEIPT_REVERSAL',
        referenceId: receipt.id,
        transactionDate: reversalDate,
        notes: `Reversal of ${receipt.grnNumber}: ${params.reason}`,
        createdById: params.userId,
      });
    }

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: receipt.id,
      createdById: params.userId,
      entryDate: reversalDate,
      reason: params.reason,
    });

    const reversed = await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'GOODS_RECEIPT_REVERSED',
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reason: params.reason },
    });

    return reversed;
  });
}

export async function deleteDraftGoodsReceipt(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const receipt = await tx.goodsReceipt.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!receipt) throw new NotFoundError('Goods receipt');
    if (receipt.status !== 'DRAFT') {
      throw new BusinessRuleError('Only a draft goods receipt can be deleted.');
    }
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'GOODS_RECEIPT_DELETED',
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      before: { grnNumber: receipt.grnNumber },
    });
    await tx.goodsReceipt.delete({ where: { id: params.id } });
  });
}
