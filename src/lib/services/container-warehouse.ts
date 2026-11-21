import { prisma, transaction } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { dec } from '@/lib/money';
import { approveStockTransfer, createStockTransfer, receiveStockTransfer } from '@/lib/services/stock-transfer';

/**
 * Change the warehouse a container is in, from the shipment page.
 *
 * Six containers arrive and one is booked into the wrong warehouse. The
 * receipt is history and stays as it was; what is corrected is where the
 * coffee is now. Everything of the container still in another warehouse —
 * every coffee in it, when it carries several — is moved to the one chosen,
 * as a stock transfer approved and received at once: the movement shows on
 * the stock ledger and on the transfers list with its own number, the
 * company's total stock never changes, and nothing is posted to the books
 * (a move between the company's own warehouses is not a transaction with
 * anyone). Coffee already sold stays sold where it was sold; coffee held for
 * a draft invoice stays where the draft holds it.
 */
export type ChangeContainerWarehouseInput = {
  companyId: string;
  /** Any coffee in the container: the whole container moves with it. */
  batchId: string;
  toWarehouseId: string;
  transferDate: Date;
  userId: string;
};

export async function changeContainerWarehouse(input: ChangeContainerWarehouseInput) {
  return transaction(async (tx) => {
    const target = await tx.warehouse.findFirst({
      where: { id: input.toWarehouseId, companyId: input.companyId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!target) throw new NotFoundError('Warehouse');

    const picked = await tx.batch.findFirst({
      where: { id: input.batchId, companyId: input.companyId },
      select: { id: true, containerId: true, shipmentId: true },
    });
    if (!picked) throw new NotFoundError('Container');
    // Every coffee in the same box on this shipment: the same container
    // number on another order is another box.
    const batches = picked.containerId
      ? await tx.batch.findMany({
          where: { companyId: input.companyId, shipmentId: picked.shipmentId, containerId: picked.containerId },
          select: { id: true },
        })
      : [{ id: picked.id }];

    const balances = await tx.inventoryBalance.findMany({
      where: { companyId: input.companyId, batchId: { in: batches.map((b) => b.id) }, warehouseId: { not: target.id } },
      select: { batchId: true, warehouseId: true, onHandKg: true, availableKg: true, reservedKg: true, bags: true },
    });
    const movable = balances.filter((b) => dec(b.availableKg).greaterThan(0));
    const held = balances.reduce((t, b) => t.plus(b.reservedKg), dec(0));
    if (movable.length === 0) {
      throw new BusinessRuleError(
        held.greaterThan(0)
          ? `Nothing can be moved: the coffee left in other warehouses is held for draft invoices.`
          : `This container is already all in ${target.name}.`,
      );
    }

    // One transfer per warehouse it leaves.
    const bySource = new Map<string, typeof movable>();
    for (const b of movable) bySource.set(b.warehouseId, [...(bySource.get(b.warehouseId) ?? []), b]);

    const transfers: string[] = [];
    let movedKg = dec(0);
    for (const [fromWarehouseId, rows] of bySource) {
      const transfer = await createStockTransfer(
        {
          companyId: input.companyId,
          transferDate: input.transferDate,
          fromWarehouseId,
          toWarehouseId: target.id,
          notes: 'Container moved to the right warehouse from the shipment page',
          lines: rows.map((r) => ({
            batchId: r.batchId,
            quantityKg: dec(r.availableKg).toString(),
            // Everything there moves: its bags go with it. Part of it held for
            // a draft: the bags follow the weight.
            ...(dec(r.reservedKg).isZero() ? { bags: r.bags } : {}),
          })),
        },
        input.userId,
      );
      const params = { id: transfer.id, companyId: input.companyId, userId: input.userId };
      await approveStockTransfer(params);
      await receiveStockTransfer(params);
      transfers.push(transfer.transferNumber);
      movedKg = movedKg.plus(rows.reduce((t, r) => t.plus(r.availableKg), dec(0)));
    }

    return { warehouseName: target.name, transfers, movedKg, heldKg: held };
  });
}

/** The warehouses a container can be moved to. */
export async function getWarehouseChoices(companyId: string, allowed: string[] | null) {
  return prisma.warehouse.findMany({
    where: { companyId, status: 'ACTIVE', ...(allowed ? { id: { in: allowed } } : {}) },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}
