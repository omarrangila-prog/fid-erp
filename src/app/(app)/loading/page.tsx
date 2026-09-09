import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatQuantityKg, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingSheet, type LoadingRow } from '@/app/(app)/loading/loading-sheet';

export const metadata: Metadata = { title: 'Loading Follow-Up' };
export const dynamic = 'force-dynamic';

export default async function LoadingPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;

  // One row per batch: the logistics team works container by container.
  const batches = await prisma.batch.findMany({
    where: { companyId, purchaseContract: { status: 'POSTED' } },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      item: { select: { itemName: true, originCountry: true } },
      lot: { select: { lotNumber: true } },
      container: { select: { containerNumber: true } },
      purchaseContract: {
        select: { contractNumber: true, contractReference: true, contractDate: true, vendor: { select: { vendorName: true } } },
      },
      shipment: {
        select: {
          id: true,
          status: true,
          documentStatus: true,
          bookingNumber: true,
          billOfLading: true,
          etaDate: true,
          customer: { select: { customerName: true } },
          shippingLine: { select: { name: true } },
        },
      },
      invoiceLines: {
        where: { salesInvoice: { status: 'POSTED' } },
        select: { salesInvoice: { select: { customer: { select: { customerName: true } } } } },
      },
    },
  });

  const rows: LoadingRow[] = batches.map((b) => {
    const ordered = dec(b.orderedQuantityKg);
    const sold = dec(b.soldQuantityKg);
    const soldStatus: LoadingRow['soldStatus'] = sold.greaterThanOrEqualTo(ordered) && ordered.greaterThan(0)
      ? 'Sold'
      : sold.greaterThan(0)
        ? 'Partly sold'
        : 'Unsold';

    const buyers = [
      ...new Set(b.invoiceLines.map((l) => l.salesInvoice.customer.customerName)),
    ];

    return {
      id: b.id,
      shipmentId: b.shipmentId,
      contractDate: formatDate(b.purchaseContract.contractDate),
      contractDateSort: b.purchaseContract.contractDate.getTime(),
      contractNumber: b.purchaseContract.contractNumber,
      contractReference: b.purchaseContract.contractReference,
      vendorName: b.purchaseContract.vendor.vendorName,
      itemName: b.item.itemName,
      origin: b.item.originCountry,
      lotNumber: b.lot.lotNumber,
      batchNumber: b.batchNumber,
      containerNumber: b.container?.containerNumber ?? null,
      quantityKg: formatQuantityKg(ordered),
      quantitySort: Number(ordered),
      bags: b.orderedBags,
      buyer: buyers.length > 0 ? buyers.join(', ') : (b.shipment.customer?.customerName ?? null),
      soldStatus,
      shippingLine: b.shipment.shippingLine?.name ?? null,
      bookingNumber: b.shipment.bookingNumber,
      billOfLading: b.shipment.billOfLading,
      etaDate: formatDate(b.shipment.etaDate),
      etaSort: b.shipment.etaDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
      status: b.shipment.status,
      documentStatus: b.shipment.documentStatus,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loading Follow-Up"
        description="One row per lot and batch, with booking, bill of lading, ETA and whether the coffee is sold."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Loading Follow-Up' }]}
      />
      <LoadingSheet
        rows={rows}
        companyCode={user.activeCompany.code}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
