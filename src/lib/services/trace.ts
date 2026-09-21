import { prisma } from '@/lib/db';
import { Decimal, dec } from '@/lib/money';

/**
 * Follow one ICUL/FID reference through its whole life.
 *
 *   order → containers → lots and batches → receipts into warehouses
 *         → where it is now → transfers → the customers who bought it
 *
 * Nothing is typed twice: every step is found through the batch, which knows
 * its order, its container and its lot, so the sale and transfer screens can
 * name the original reference without anybody copying it.
 */

export async function traceReference(companyId: string, reference: string) {
  const q = reference.trim();
  if (q.length < 2) return null;

  const orders = await prisma.purchaseContract.findMany({
    where: { companyId, contractReference: { contains: q, mode: 'insensitive' }, status: { in: ['POSTED', 'DRAFT'] } },
    orderBy: { contractDate: 'desc' },
    take: 5,
    select: {
      id: true,
      contractReference: true,
      contractDate: true,
      status: true,
      vendor: { select: { vendorName: true } },
    },
  });
  if (orders.length === 0) return { reference: q, orders: [] };

  const traced = [];
  for (const order of orders) {
    const [shipments, batches] = await Promise.all([
      prisma.shipment.findMany({
        where: { purchaseContractId: order.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, etaDate: true, containerList: { select: { containerNumber: true } } },
      }),
      prisma.batch.findMany({
        where: { purchaseContractId: order.id },
        orderBy: { batchNumber: 'asc' },
        select: {
          id: true,
          batchNumber: true,
          status: true,
          orderedQuantityKg: true,
          receivedQuantityKg: true,
          soldQuantityKg: true,
          shipmentId: true,
          item: { select: { itemName: true } },
          lot: { select: { lotNumber: true } },
          container: { select: { containerNumber: true } },
        },
      }),
    ]);
    const batchIds = batches.map((b) => b.id);

    const [receipts, stock, transfers, sales] = await Promise.all([
      prisma.goodsReceiptLine.findMany({
        where: { batchId: { in: batchIds }, goodsReceipt: { status: 'POSTED' } },
        select: {
          quantityKg: true,
          batch: { select: { batchNumber: true } },
          goodsReceipt: { select: { id: true, grnNumber: true, receiptDate: true, warehouse: { select: { name: true } } } },
        },
        orderBy: { goodsReceipt: { receiptDate: 'asc' } },
      }),
      prisma.inventoryBalance.findMany({
        where: { batchId: { in: batchIds }, onHandKg: { not: 0 } },
        select: { onHandKg: true, availableKg: true, warehouse: { select: { name: true } }, batch: { select: { batchNumber: true, item: { select: { itemName: true } } } } },
      }),
      prisma.stockTransferLine.findMany({
        where: { batchId: { in: batchIds } },
        select: {
          quantityKg: true,
          batch: { select: { batchNumber: true } },
          stockTransfer: {
            select: {
              id: true,
              transferNumber: true,
              transferDate: true,
              workflowState: true,
              status: true,
              fromWarehouse: { select: { name: true } },
              toWarehouse: { select: { name: true } },
            },
          },
        },
        orderBy: { stockTransfer: { transferDate: 'asc' } },
      }),
      prisma.salesInvoiceLine.findMany({
        where: { batchId: { in: batchIds }, salesInvoice: { status: 'POSTED' } },
        select: {
          quantityKg: true,
          lineTotal: true,
          batch: { select: { batchNumber: true } },
          item: { select: { itemName: true } },
          warehouse: { select: { name: true } },
          salesInvoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, currency: true, customer: { select: { id: true, customerName: true } } } },
        },
        orderBy: { salesInvoice: { invoiceDate: 'asc' } },
      }),
    ]);

    const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));
    traced.push({
      order,
      shipments,
      batches,
      receipts,
      stock,
      transfers,
      sales,
      totals: {
        orderedKg: sum(batches.map((b) => dec(b.orderedQuantityKg))),
        receivedKg: sum(batches.map((b) => dec(b.receivedQuantityKg))),
        soldKg: sum(sales.map((s) => dec(s.quantityKg))),
        onHandKg: sum(stock.map((s) => dec(s.onHandKg))),
      },
      customers: [...new Map(sales.map((s) => [s.salesInvoice.customer.id, s.salesInvoice.customer])).values()],
    });
  }
  return { reference: q, orders: traced };
}
