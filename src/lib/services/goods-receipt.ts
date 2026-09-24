import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity, toUnitCost, sum } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { receiveStock, recordMovement, lockBatch } from '@/lib/services/inventory';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { markArrivedOnReceipt } from '@/lib/services/shipment';

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
  /** The contract's batch this quantity belongs to. */
  batchId: string;
  quantityKg: string | number;
  /**
   * What the coffee actually arrived as.
   *
   * At contract stage the supplier had usually not identified it, so the batch
   * carries a placeholder. These are the real numbers, and naming a second set
   * against the same contract batch splits it: 42 MT ordered can land as
   * 21 MT under lot 120229 and 21 MT under lot 120230.
   *
   * One of the two is required — enforced in validation, and again here.
   */
  lotNumber?: string | null;
  batchNumber?: string | null;
  containerNumber?: string | null;
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
  /** The shipment this batch sailed on — its own, now that a contract may hold several. */
  shipmentId: string;
  batchNumber: string;
  lotNumber: string | null;
  containerNumber: string | null;
  quantityKg: Decimal;
  bags: number;
  landedUnitCostUsd: Decimal;
  notes: string | null;
};

/**
 * Give the arriving coffee the identity it actually arrived under.
 *
 * The contract may have named a lot; usually it did not, and the batch carries
 * a placeholder issued when the contract was approved. This runs before the
 * receipt is resolved and does two things:
 *
 *   - names a placeholder batch with the supplier's real lot, and
 *   - splits one contract batch into several when the coffee arrived under
 *     more than one — 42 MT ordered landing as 21 MT under 120229 and 21 MT
 *     under 120230, which is the case the client showed us.
 *
 * The split is a real division of the contract line: the original batch gives
 * up quantity, bags and cost in proportion, and the new batch takes them. The
 * two together still tie back to the contract, so the in-transit journal
 * posted at approval needs no adjustment.
 *
 * Returns the input lines rewritten to point at whichever batch now holds
 * their identity.
 */
async function applyReceiptTraceability(
  tx: Tx,
  input: GoodsReceiptInput,
): Promise<GoodsReceiptLineInput[]> {
  const rewritten: GoodsReceiptLineInput[] = [];
  /** Identity already assigned to a batch during this receipt. */
  const assigned = new Map<string, string>();

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i];
    const lotNumber = line.lotNumber?.trim() || null;
    const batchNumber = line.batchNumber?.trim() || null;
    const containerNumber = line.containerNumber?.trim() || null;

    const batch = await tx.batch.findFirst({
      where: { id: line.batchId, companyId: input.companyId, purchaseContractId: input.purchaseContractId },
      include: { lot: { select: { lotNumber: true } } },
    });
    if (!batch) throw new NotFoundError(`Batch on line ${i + 1}`);

    // Nothing to name: the contract already said what this coffee is, and
    // asking again would be asking the user to retype the purchase order.
    if (!lotNumber && !batchNumber) {
      if (batch.traceabilityPending) {
        throw new BusinessRuleError(
          `Line ${i + 1}: enter a Lot Number or a Batch Number. This is the point the coffee becomes stock, and stock without an identity cannot be traced to a customer later.`,
        );
      }
      rewritten.push({ ...line, batchId: batch.id });
      continue;
    }

    // Whichever the supplier gave; the missing one mirrors the other rather
    // than being invented.
    const effectiveLot = lotNumber ?? batchNumber!;
    const effectiveBatch = batchNumber ?? lotNumber!;
    const identity = `${effectiveLot}\u0000${effectiveBatch}`;

    // Already carries exactly this identity — the contract named the lot, or
    // an earlier receipt did. Nothing to name and nothing to split.
    const alreadyThisIdentity =
      !batch.traceabilityPending &&
      batch.batchNumber === effectiveBatch &&
      batch.lot.lotNumber === effectiveLot;

    if (alreadyThisIdentity) {
      rewritten.push({ ...line, batchId: batch.id });
      continue;
    }

    const claimed = assigned.get(`${batch.id}${identity}`);
    if (claimed) {
      rewritten.push({ ...line, batchId: claimed });
      continue;
    }

    const firstUseOfThisBatch = ![...assigned.keys()].some((key) => key.startsWith(batch.id));

    if (firstUseOfThisBatch && batch.traceabilityPending) {
      // Name the placeholder in place. Nothing has been received against it
      // yet, so there is no history to carry.
      const lotId = await resolveLot(tx, input.companyId, effectiveLot, batch.itemId, batch.purchaseContractId);
      const containerId = containerNumber
        ? await resolveContainer(tx, input.companyId, containerNumber, batch)
        : batch.containerId;

      await assertBatchNumberIsFree(tx, input.companyId, effectiveBatch, batch.id);
      await tx.batch.update({
        where: { id: batch.id },
        data: { batchNumber: effectiveBatch, lotId, containerId, traceabilityPending: false },
      });

      assigned.set(`${batch.id}${identity}`, batch.id);
      rewritten.push({ ...line, batchId: batch.id });
      continue;
    }

    // A second identity against the same contract batch: split it.
    const split = await splitBatch(tx, {
      companyId: input.companyId,
      batch,
      quantityKg: toQuantity(line.quantityKg),
      lotNumber: effectiveLot,
      batchNumber: effectiveBatch,
      containerNumber,
    });

    assigned.set(`${batch.id}${identity}`, split.id);
    rewritten.push({ ...line, batchId: split.id });
  }

  return rewritten;
}

/** The lot with this number, reused across batches that quote the same one. */
async function resolveLot(
  tx: Tx,
  companyId: string,
  lotNumber: string,
  itemId: string,
  purchaseContractId: string,
): Promise<string> {
  const existing = await tx.lot.findFirst({ where: { companyId, lotNumber }, select: { id: true, itemId: true } });
  if (existing) {
    if (existing.itemId !== itemId) {
      throw new BusinessRuleError(
        `Lot "${lotNumber}" already exists for a different coffee. Use a lot number of its own.`,
      );
    }
    return existing.id;
  }

  const created = await tx.lot.create({
    data: { companyId, lotNumber, itemId, purchaseContractId },
    select: { id: true },
  });
  return created.id;
}

async function resolveContainer(
  tx: Tx,
  companyId: string,
  containerNumber: string,
  batch: { shipmentId: string; purchaseContractId: string },
): Promise<string> {
  const existing = await tx.container.findFirst({ where: { companyId, containerNumber }, select: { id: true } });
  if (existing) return existing.id;

  const created = await tx.container.create({
    data: {
      companyId,
      containerNumber,
      purchaseContractId: batch.purchaseContractId,
      shipmentId: batch.shipmentId,
    },
    select: { id: true },
  });
  return created.id;
}

async function assertBatchNumberIsFree(
  tx: Tx,
  companyId: string,
  batchNumber: string,
  excludeId: string,
): Promise<void> {
  const clash = await tx.batch.findFirst({
    where: { companyId, batchNumber, NOT: { id: excludeId } },
    select: { batchNumber: true, purchaseContract: { select: { contractNumber: true } } },
  });
  if (clash) {
    throw new BusinessRuleError(
      `Batch number "${batchNumber}" is already used by ${clash.purchaseContract?.contractNumber ?? 'another contract'}.`,
    );
  }
}

/**
 * Divide a contract batch in two.
 *
 * Quantity, bags and cost move across in proportion, so the sum of the parts
 * is still what the contract said. Only coffee not yet received can be split:
 * once some has landed, its history belongs to the batch it landed under.
 */
async function splitBatch(
  tx: Tx,
  params: {
    companyId: string;
    batch: {
      id: string;
      itemId: string;
      shipmentId: string;
      purchaseContractId: string;
      purchaseContractLineId: string | null;
      containerId: string | null;
      batchNumber: string;
      orderedQuantityKg: Decimal;
      receivedQuantityKg: Decimal;
      inTransitQuantityKg: Decimal;
      orderedBags: number;
      bagWeightKg: Decimal;
      unitCost: Decimal;
      currency: string;
      unitCostUsd: Decimal;
      purchaseCostUsd: Decimal;
      capitalisedCostUsd: Decimal;
      landedUnitCostUsd: Decimal;
    };
    quantityKg: Decimal;
    lotNumber: string;
    batchNumber: string;
    containerNumber: string | null;
  },
) {
  const { batch } = params;
  const remaining = toQuantity(dec(batch.orderedQuantityKg).minus(dec(batch.receivedQuantityKg)));

  if (params.quantityKg.greaterThan(remaining)) {
    throw new BusinessRuleError(
      `Only ${remaining.toFixed(3)} KG of ${batch.batchNumber} is still to be received, but ${params.quantityKg.toFixed(3)} KG was entered against lot ${params.lotNumber}.`,
    );
  }

  await assertBatchNumberIsFree(tx, params.companyId, params.batchNumber, batch.id);

  const lotId = await resolveLot(
    tx,
    params.companyId,
    params.lotNumber,
    batch.itemId,
    batch.purchaseContractId,
  );
  const containerId = params.containerNumber
    ? await resolveContainer(tx, params.companyId, params.containerNumber, batch)
    : batch.containerId;

  const share = dec(batch.orderedQuantityKg).isZero()
    ? dec(0)
    : params.quantityKg.dividedBy(dec(batch.orderedQuantityKg));
  const movedCostUsd = toMoney(dec(batch.purchaseCostUsd).times(share));
  const movedCapitalisedUsd = toMoney(dec(batch.capitalisedCostUsd).times(share));
  const movedBags = Math.round(batch.orderedBags * Number(share));

  const remainingOrdered = toQuantity(dec(batch.orderedQuantityKg).minus(params.quantityKg));
  const remainingPurchase = toMoney(dec(batch.purchaseCostUsd).minus(movedCostUsd));
  const remainingCapitalised = toMoney(dec(batch.capitalisedCostUsd).minus(movedCapitalisedUsd));
  const remainingLandedUnit = remainingOrdered.greaterThan(0)
    ? toUnitCost(remainingPurchase.plus(remainingCapitalised).dividedBy(remainingOrdered))
    : new Decimal(0);
  const newLandedUnit = params.quantityKg.greaterThan(0)
    ? toUnitCost(movedCostUsd.plus(movedCapitalisedUsd).dividedBy(params.quantityKg))
    : new Decimal(0);

  await tx.batch.update({
    where: { id: batch.id },
    data: {
      orderedQuantityKg: remainingOrdered,
      inTransitQuantityKg: toQuantity(dec(batch.inTransitQuantityKg).minus(params.quantityKg)),
      orderedBags: Math.max(0, batch.orderedBags - movedBags),
      purchaseCostUsd: remainingPurchase,
      capitalisedCostUsd: remainingCapitalised,
      landedUnitCostUsd: remainingLandedUnit,
    },
  });

  return tx.batch.create({
    data: {
      companyId: params.companyId,
      batchNumber: params.batchNumber,
      traceabilityPending: false,
      itemId: batch.itemId,
      lotId,
      containerId,
      shipmentId: batch.shipmentId,
      purchaseContractId: batch.purchaseContractId,
      purchaseContractLineId: batch.purchaseContractLineId,
      orderedQuantityKg: params.quantityKg,
      inTransitQuantityKg: params.quantityKg,
      orderedBags: movedBags,
      bagWeightKg: batch.bagWeightKg,
      unitCost: batch.unitCost,
      currency: batch.currency,
      unitCostUsd: batch.unitCostUsd,
      purchaseCostUsd: movedCostUsd,
      capitalisedCostUsd: movedCapitalisedUsd,
      landedUnitCostUsd: newLandedUnit,
    },
  });
}

async function resolveLines(tx: Tx, input: GoodsReceiptInput): Promise<ResolvedGrnLine[]> {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A goods receipt needs at least one line.');
  }

  const resolved: ResolvedGrnLine[] = [];
  const claimedKg = new Map<string, Decimal>();

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
        shipmentId: true,
        orderedQuantityKg: true,
        receivedQuantityKg: true,
        landedUnitCostUsd: true,
        unitCostUsd: true,
        status: true,
        lot: { select: { lotNumber: true } },
        container: { select: { containerNumber: true } },
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

    const outstanding = toQuantity(
      dec(batch.orderedQuantityKg).minus(dec(batch.receivedQuantityKg)).minus(claimedKg.get(batch.id) ?? 0),
    );
    assertWithinOverReceipt(batch.batchNumber, dec(batch.orderedQuantityKg), outstanding, quantityKg);
    claimedKg.set(batch.id, (claimedKg.get(batch.id) ?? new Decimal(0)).plus(quantityKg));

    resolved.push({
      lineNumber: i + 1,
      batchId: batch.id,
      itemId: batch.itemId,
      containerId: batch.containerId,
      contractLineId: batch.purchaseContractLineId,
      shipmentId: batch.shipmentId,
      batchNumber: batch.batchNumber,
      // Recorded on the receipt line as well as the batch, so the document
      // still says what arrived even if the batch is later merged or renamed.
      lotNumber: batch.lot?.lotNumber ?? null,
      containerNumber: batch.container?.containerNumber ?? null,
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

/** The receipt, inside a transaction somebody else opened. */
/**
 * Up to a tenth more than ordered may be received — a weighbridge reading
 * is never the contract figure to the kilogram. Beyond that it is almost
 * certainly a typo, and the message says what would be needed instead.
 */
const OVER_RECEIPT_TOLERANCE = new Decimal('0.10');

function assertWithinOverReceipt(batchNumber: string, orderedKg: Decimal, outstandingKg: Decimal, quantityKg: Decimal) {
  if (quantityKg.lessThanOrEqualTo(outstandingKg)) return;
  const allowance = toQuantity(orderedKg.times(OVER_RECEIPT_TOLERANCE));
  if (quantityKg.minus(outstandingKg).lessThanOrEqualTo(allowance)) return;
  throw new BusinessRuleError(
    `Batch ${batchNumber}: ${outstandingKg.toFixed(3)} KG is still to be received and up to ${allowance.toFixed(3)} KG more than ordered can be accepted, but ${quantityKg.toFixed(3)} KG was entered. Check the weight, or correct the order first.`,
  );
}

export async function createGoodsReceiptIn(tx: Tx, input: GoodsReceiptInput, userId: string) {
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

  // Name the placeholder batches and split any that arrived under more than
  // one lot, then resolve against the batches that result.
  const withIdentity = await applyReceiptTraceability(tx, input);
  const lines = await resolveLines(tx, { ...input, lines: withIdentity });

  const grnNumber = await nextReference(tx, { companyId: input.companyId, docType: 'GRN' });

  const receipt = await tx.goodsReceipt.create({
    data: {
      companyId: input.companyId,
      grnNumber,
      receiptDate: input.receiptDate,
      purchaseContractId: contract.id,
      /*
       * A contract may hold several shipments now, and a receipt may land
       * coffee from more than one of them. The header names a shipment only
       * when every batch received came off the same one; each batch keeps
       * its own shipment regardless, so nothing is lost either way.
       */
      shipmentId: (() => {
        const ids = new Set(lines.map((l) => l.shipmentId).filter(Boolean));
        return ids.size === 1 ? [...ids][0] : null;
      })(),
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
          lotNumber: l.lotNumber,
          batchNumber: l.batchNumber,
          containerNumber: l.containerNumber,
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
}

export async function createGoodsReceipt(input: GoodsReceiptInput, userId: string) {
  return transaction((tx) => createGoodsReceiptIn(tx, input, userId));
}

/** Posting, inside a transaction somebody else opened. */
export async function postGoodsReceiptIn(tx: Tx, params: { id: string; companyId: string; userId: string }) {
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

  const batchIds = [...new Set(receipt.lines.map((line) => line.batchId))].sort();
  for (const batchId of batchIds) {
    await lockBatch(tx, params.companyId, batchId);
  }

  const claimedKg = new Map<string, Decimal>();

  for (const line of receipt.lines) {
    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: line.batchId },
      select: {
        id: true,
        batchNumber: true,
        orderedQuantityKg: true,
        receivedQuantityKg: true,
        landedUnitCostUsd: true,
        unitCostUsd: true,
        warehouseId: true,
      },
    });
    const outstanding = toQuantity(
      dec(batch.orderedQuantityKg)
        .minus(dec(batch.receivedQuantityKg))
        .minus(claimedKg.get(line.batchId) ?? 0),
    );
    assertWithinOverReceipt(batch.batchNumber, dec(batch.orderedQuantityKg), outstanding, dec(line.quantityKg));
    claimedKg.set(line.batchId, (claimedKg.get(line.batchId) ?? new Decimal(0)).plus(line.quantityKg));

    /*
     * The weighbridge, not the contract, says how much coffee came in.
     *
     * When more lands than was ordered, the supplier is still owed the
     * contract value and no more, so the extra kilograms carry no extra
     * cost: the value moved out of Inventory in Transit is capped at what
     * that batch still has there, and the receipt's unit cost is that value
     * spread over everything received. Inventory ends up holding exactly
     * the purchase value, and in-transit ends at zero rather than below it.
     */
    const batchUnitCost = dec(batch.landedUnitCostUsd).greaterThan(0)
      ? dec(batch.landedUnitCostUsd)
      : dec(batch.unitCostUsd);
    const quantity = dec(line.quantityKg);
    const unitCostUsd = quantity.greaterThan(outstanding)
      ? toUnitCost(Decimal.max(outstanding, 0).times(batchUnitCost).dividedBy(quantity))
      : batchUnitCost;

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

  /*
   * The cargo is in the warehouse, so the shipment it came on has arrived.
   * Left unsaid, a receipt taken without first pressing "Mark arrived" made
   * the order read "0 of 2 arrived" while the stock sat on the shelf.
   */
  // The receipt's own shipment, plus any the batches it received belong to.
  const shipmentIds = [
    ...new Set(
      [receipt.shipmentId, ...receipt.lines.map((line) => line.batch?.shipmentId ?? null)].filter(Boolean) as string[],
    ),
  ];
  for (const shipmentId of shipmentIds) {
    await markArrivedOnReceipt(tx, {
      companyId: params.companyId,
      shipmentId,
      userId: params.userId,
      receiptDate: receipt.receiptDate,
      reference: receipt.grnNumber,
    });
  }

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
}

export async function postGoodsReceipt(params: { id: string; companyId: string; userId: string }) {
  return transaction((tx) => postGoodsReceiptIn(tx, params));
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

export type ContainerReceiptLine = GoodsReceiptLineInput & { warehouseId: string };

export type ReceiveContainersInput = {
  companyId: string;
  purchaseContractId: string;
  receiptDate: Date;
  receivedById: string;
  reference?: string | null;
  notes?: string | null;
  /** One per container being received, each naming its own warehouse. */
  lines: ContainerReceiptLine[];
};

/**
 * Receive whichever containers the user ticked, into whichever warehouses
 * they named, as one operation.
 *
 * Three containers landing together and going to two warehouses is one
 * event to the person at the gate, so it is one press of the button. A
 * goods receipt lands in one warehouse, so the containers are grouped by
 * warehouse into as many receipts as needed — created and posted inside one
 * transaction, so either every container becomes stock or none does.
 */
export async function receiveContainers(input: ReceiveContainersInput) {
  if (input.lines.length === 0) throw new BusinessRuleError('Choose at least one container to receive.');

  const byWarehouse = new Map<string, GoodsReceiptLineInput[]>();
  for (const { warehouseId, ...line } of input.lines) {
    if (!warehouseId) throw new BusinessRuleError('Choose a warehouse for every container being received.');
    byWarehouse.set(warehouseId, [...(byWarehouse.get(warehouseId) ?? []), line]);
  }

  return transaction(async (tx) => {
    const receipts: Array<{ id: string; grnNumber: string; warehouseId: string }> = [];
    for (const [warehouseId, lines] of byWarehouse) {
      const receipt = await createGoodsReceiptIn(
        tx,
        {
          companyId: input.companyId,
          purchaseContractId: input.purchaseContractId,
          warehouseId,
          receiptDate: input.receiptDate,
          receivedById: input.receivedById,
          reference: input.reference,
          notes: input.notes,
          lines,
        },
        input.receivedById,
      );
      await postGoodsReceiptIn(tx, { id: receipt.id, companyId: input.companyId, userId: input.receivedById });
      receipts.push({ id: receipt.id, grnNumber: receipt.grnNumber, warehouseId });
    }
    return receipts;
  }, 60_000);
}
