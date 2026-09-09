import { transaction } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { adjustStock } from '@/lib/services/inventory';
import type { StockAdjustmentReason } from '@prisma/client';

/**
 * Physical stock count.
 *
 * The sheet snapshots what the system believes is in the warehouse at the
 * moment it is produced, so a movement posted while somebody is walking the
 * aisles cannot silently change what they were asked to verify. Differences
 * are posted as inventory adjustments valued at each batch's landed cost, and
 * every line carries a reason — an unexplained write-off is how shrinkage gets
 * hidden.
 */

export async function createStockCount(
  input: { companyId: string; warehouseId: string; countDate: Date; notes?: string | null },
  userId: string,
) {
  return transaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({
      where: { id: input.warehouseId, companyId: input.companyId },
      select: { id: true, name: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse');

    const open = await tx.stockCount.findFirst({
      where: { companyId: input.companyId, warehouseId: input.warehouseId, status: { in: ['DRAFT', 'COUNTED'] } },
      select: { countNumber: true },
    });
    if (open) {
      throw new ConflictError(
        `Count ${open.countNumber} is still open for this warehouse. Finish or cancel it before starting another.`,
      );
    }

    const balances = await tx.inventoryBalance.findMany({
      where: { companyId: input.companyId, warehouseId: input.warehouseId },
      select: { batchId: true, onHandKg: true },
    });
    if (balances.length === 0) {
      throw new BusinessRuleError('There is no stock recorded in this warehouse to count.');
    }

    const countNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.STOCK_COUNT,
    });

    const count = await tx.stockCount.create({
      data: {
        companyId: input.companyId,
        countNumber,
        countDate: input.countDate,
        warehouseId: input.warehouseId,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
        lines: {
          create: balances.map((balance) => ({
            batchId: balance.batchId,
            systemKg: balance.onHandKg,
            countedKg: null,
            differenceKg: 0,
          })),
        },
      },
      include: { lines: true },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'STOCK_COUNT_CREATED',
      entityType: 'StockCount',
      entityId: count.id,
      after: { number: count.countNumber, warehouse: warehouse.name, lines: count.lines.length },
    });

    return count;
  });
}

export async function recordCount(
  params: {
    id: string;
    companyId: string;
    userId: string;
    lines: Array<{ batchId: string; countedKg: string | number; reason?: StockAdjustmentReason | null; notes?: string | null }>;
  },
) {
  return transaction(async (tx) => {
    const count = await tx.stockCount.findFirst({
      where: { id: params.id, companyId: params.companyId },
      include: { lines: true },
    });
    if (!count) throw new NotFoundError('Stock count');
    if (count.status === 'POSTED' || count.status === 'CANCELLED') {
      throw new BusinessRuleError(`This count is ${count.status.toLowerCase()} and can no longer be edited.`);
    }

    for (const input of params.lines) {
      const line = count.lines.find((l) => l.batchId === input.batchId);
      if (!line) throw new NotFoundError('Stock count line');

      const countedKg = toQuantity(input.countedKg);
      if (countedKg.lessThan(0)) {
        throw new BusinessRuleError('A counted quantity cannot be negative.');
      }
      const difference = toQuantity(countedKg.minus(line.systemKg));

      // A difference has to be explained before it can be posted.
      if (!difference.isZero() && !input.reason) {
        throw new BusinessRuleError(
          'Every difference needs a reason — damage, loss, a count correction or an explanation of your own.',
        );
      }

      await tx.stockCountLine.update({
        where: { id: line.id },
        data: {
          countedKg,
          differenceKg: difference,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
        },
      });
    }

    return tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'COUNTED', countedById: params.userId },
      include: { lines: true },
    });
  });
}

export async function postStockCount(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM stock_counts
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Stock count');
    if (locked[0].status !== 'COUNTED') {
      throw new ConflictError('Only a completed count can be posted. Record the counted quantities first.');
    }

    const count = await tx.stockCount.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: { include: { batch: true } }, warehouse: true },
    });
    const company = await getCompanyContext(tx, params.companyId);

    let increaseUsd = new Decimal(0);
    let decreaseUsd = new Decimal(0);

    for (const line of count.lines) {
      const difference = dec(line.differenceKg);
      if (difference.isZero()) continue;

      await adjustStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: count.warehouseId,
        quantityKg: difference,
        reason: `${count.countNumber} — ${line.reason ?? 'COUNT_ADJUSTMENT'}${line.notes ? `: ${line.notes}` : ''}`,
        transactionDate: count.countDate,
        createdById: params.userId,
      });

      const value = toMoney(difference.abs().times(line.batch.landedUnitCostUsd));
      if (difference.greaterThan(0)) increaseUsd = increaseUsd.plus(value);
      else decreaseUsd = decreaseUsd.plus(value);
    }

    const netUsd = toMoney(increaseUsd.minus(decreaseUsd));

    // Only post when there is something to post: a clean count writes no entry.
    if (!netUsd.isZero()) {
      const gain = netUsd.greaterThan(0);
      await postJournalEntry(tx, {
        companyId: params.companyId,
        entryDate: count.countDate,
        description: `Stock count ${count.countNumber} — ${count.warehouse.name}`,
        sourceType: 'STOCK_COUNT',
        sourceId: count.id,
        createdById: params.userId,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: 1,
        lines: [
          {
            accountKey: ACCOUNT_KEYS.INVENTORY,
            direction: gain ? 'DEBIT' : 'CREDIT',
            currency: 'USD',
            amount: netUsd.abs(),
            rateToUsd: 1,
            description: gain ? 'Stock found on count' : 'Stock short on count',
          },
          {
            accountKey: ACCOUNT_KEYS.INVENTORY_ADJUSTMENT,
            direction: gain ? 'CREDIT' : 'DEBIT',
            currency: 'USD',
            amount: netUsd.abs(),
            rateToUsd: 1,
            description: `Count difference on ${count.countNumber}`,
          },
        ],
      });
    }

    const posted = await tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'POSTED', postedAt: new Date(), approvedById: params.userId },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_COUNT_POSTED',
      entityType: 'StockCount',
      entityId: count.id,
      after: {
        number: count.countNumber,
        increaseUsd: increaseUsd.toString(),
        decreaseUsd: decreaseUsd.toString(),
        netUsd: netUsd.toString(),
      },
    });

    return posted;
  });
}

export async function cancelStockCount(params: { id: string; companyId: string; userId: string; reason: string }) {
  return transaction(async (tx) => {
    const count = await tx.stockCount.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!count) throw new NotFoundError('Stock count');
    if (count.status === 'POSTED') {
      throw new BusinessRuleError('A posted count cannot be cancelled. Raise an adjustment instead.');
    }

    const cancelled = await tx.stockCount.update({
      where: { id: count.id },
      data: { status: 'CANCELLED', notes: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'STOCK_COUNT_CANCELLED',
      entityType: 'StockCount',
      entityId: count.id,
      after: { reason: params.reason },
    });

    return cancelled;
  });
}
