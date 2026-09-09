import { prisma } from '@/lib/db';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';

/**
 * Global search.
 *
 * Every branch is scoped to the active company and gated on the permission the
 * corresponding module requires, so search can never become a side channel for
 * data a user is not allowed to open.
 */

export type SearchResult = {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  href: string;
};

export async function globalSearch(params: {
  companyId: string;
  query: string;
  permissions: Set<PermissionCode>;
  isSuperAdmin: boolean;
  limit?: number;
}): Promise<SearchResult[]> {
  const q = params.query.trim();
  if (q.length < 2) return [];

  const limit = params.limit ?? 8;
  const can = (p: PermissionCode) => params.isSuperAdmin || params.permissions.has(p);
  const contains = { contains: q, mode: 'insensitive' as const };
  const results: SearchResult[] = [];

  if (can(PERMISSIONS.CUSTOMERS_VIEW)) {
    const rows = await prisma.customer.findMany({
      where: { companyId: params.companyId, OR: [{ customerName: contains }, { customerCode: contains }] },
      take: limit,
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Customer',
        title: r.customerName,
        subtitle: `${r.customerCode} · ${r.primaryCurrency}`,
        href: `/customers/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.VENDORS_VIEW)) {
    const rows = await prisma.vendor.findMany({
      where: { companyId: params.companyId, OR: [{ vendorName: contains }, { vendorCode: contains }] },
      take: limit,
      select: { id: true, vendorName: true, vendorCode: true, primaryCurrency: true },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Vendor',
        title: r.vendorName,
        subtitle: `${r.vendorCode} · ${r.primaryCurrency}`,
        href: `/vendors/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.PURCHASES_VIEW)) {
    const rows = await prisma.purchaseContract.findMany({
      where: {
        companyId: params.companyId,
        OR: [{ contractNumber: contains }, { contractReference: contains }],
      },
      take: limit,
      select: { id: true, contractNumber: true, contractReference: true, vendor: { select: { vendorName: true } } },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Purchase Contract',
        title: r.contractNumber,
        subtitle: `${r.contractReference} · ${r.vendor.vendorName}`,
        href: `/purchases/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.SHIPMENTS_VIEW)) {
    const rows = await prisma.shipment.findMany({
      where: {
        companyId: params.companyId,
        OR: [
          { shipmentNumber: contains },
          { jobNumber: contains },
          { bookingNumber: contains },
          { billOfLading: contains },
        ],
      },
      take: limit,
      select: {
        id: true,
        shipmentNumber: true,
        jobNumber: true,
        bookingNumber: true,
        billOfLading: true,
        status: true,
        item: { select: { itemName: true } },
      },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Shipment',
        title: `${r.shipmentNumber} · ${r.jobNumber}`,
        subtitle: [r.item.itemName, r.bookingNumber, r.billOfLading, r.status.replaceAll('_', ' ')]
          .filter(Boolean)
          .join(' · '),
        href: `/shipments/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.SALES_VIEW)) {
    const rows = await prisma.salesInvoice.findMany({
      where: { companyId: params.companyId, OR: [{ invoiceNumber: contains }, { reference: contains }] },
      take: limit,
      select: { id: true, invoiceNumber: true, customer: { select: { customerName: true } }, currency: true },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Sales Invoice',
        title: r.invoiceNumber,
        subtitle: `${r.customer.customerName} · ${r.currency}`,
        href: `/sales/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.ITEMS_VIEW)) {
    const rows = await prisma.coffeeItem.findMany({
      where: {
        companyId: params.companyId,
        OR: [{ itemName: contains }, { itemCode: contains }, { originCountry: contains }, { grade: contains }],
      },
      take: limit,
      select: { id: true, itemName: true, itemCode: true, originCountry: true, grade: true },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Coffee',
        title: r.itemName,
        subtitle: [r.itemCode, r.originCountry, r.grade].filter(Boolean).join(' · '),
        href: `/items/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.INVENTORY_VIEW)) {
    const batches = await prisma.batch.findMany({
      where: { companyId: params.companyId, batchNumber: contains },
      take: limit,
      select: {
        id: true,
        batchNumber: true,
        availableQuantityKg: true,
        item: { select: { itemName: true } },
        lot: { select: { lotNumber: true } },
      },
    });
    results.push(
      ...batches.map((r) => ({
        id: r.id,
        type: 'Batch',
        title: r.batchNumber,
        subtitle: `${r.item.itemName} · Lot ${r.lot.lotNumber} · ${r.availableQuantityKg.toString()} KG available`,
        href: `/inventory/batches/${r.id}`,
      })),
    );

    const lots = await prisma.lot.findMany({
      where: { companyId: params.companyId, lotNumber: contains },
      take: limit,
      select: { id: true, lotNumber: true, originCountry: true, item: { select: { itemName: true } } },
    });
    results.push(
      ...lots.map((r) => ({
        id: r.id,
        type: 'Lot',
        title: r.lotNumber,
        subtitle: [r.item.itemName, r.originCountry].filter(Boolean).join(' · '),
        href: `/inventory/batches?lot=${r.id}`,
      })),
    );

    const containers = await prisma.container.findMany({
      where: { companyId: params.companyId, containerNumber: contains },
      take: limit,
      select: {
        id: true,
        containerNumber: true,
        containerType: true,
        shipment: { select: { id: true, shipmentNumber: true } },
      },
    });
    results.push(
      ...containers.map((r) => ({
        id: r.id,
        type: 'Container',
        title: r.containerNumber,
        subtitle: [r.containerType, r.shipment?.shipmentNumber].filter(Boolean).join(' · '),
        href: r.shipment ? `/shipments/${r.shipment.id}` : '/inventory/batches',
      })),
    );
  }

  if (can(PERMISSIONS.CHEQUES_VIEW)) {
    const rows = await prisma.cheque.findMany({
      where: { companyId: params.companyId, chequeNumber: contains },
      take: limit,
      select: {
        id: true,
        chequeNumber: true,
        status: true,
        currency: true,
        amount: true,
        bankName: true,
      },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Cheque',
        title: r.chequeNumber,
        subtitle: `${r.bankName} · ${r.currency} ${r.amount.toString()} · ${r.status.toLowerCase()}`,
        href: `/finance/cheques/${r.id}`,
      })),
    );
  }

  if (can(PERMISSIONS.RECEIPTS_VIEW)) {
    const rows = await prisma.receipt.findMany({
      where: { companyId: params.companyId, OR: [{ receiptNumber: contains }, { reference: contains }] },
      take: limit,
      select: { id: true, receiptNumber: true, customer: { select: { customerName: true } }, currency: true },
    });
    results.push(
      ...rows.map((r) => ({
        id: r.id,
        type: 'Receipt',
        title: r.receiptNumber,
        subtitle: `${r.customer.customerName} · ${r.currency}`,
        href: `/finance/receipts/${r.id}`,
      })),
    );
  }

  return results.slice(0, 30);
}
