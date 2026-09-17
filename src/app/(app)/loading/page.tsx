import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { formatQuantityKg, formatDate, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Callout } from '@/components/ui/feedback';
import { LoadingSheet, type LoadingLine, type LoadingRow } from '@/app/(app)/loading/loading-sheet';

export const metadata: Metadata = { title: 'Loading Follow-Up' };
export const dynamic = 'force-dynamic';

export default async function LoadingPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);

  const [sheet, shippingLines, warehouses, ports] = await Promise.all([
    getLoadingSheet(user.activeCompany.id),
    prisma.shippingLine.findMany({
      where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.warehouse.findMany({
      where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, isDefault: true },
    }),
    prisma.port.findMany({
      where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { name: true },
    }),
  ]);

  // Dubai trades container to container; Morocco buys a container and sells it
  // to many customers. The two paper sheets differ, so the two screens do too.
  const isDubai = user.activeCompany.localCurrency === 'AED';

  const rows: LoadingRow[] = sheet.map((row) => {
    const quantityKg = Number(row.quantityKg);
    const receivedKg = Number(row.receivedKg);
    const lines: LoadingLine[] = row.lines.map((line) => ({
      batchId: line.batchId,
      itemName: line.itemName,
      origin: line.origin,
      lotNumber: line.lotNumber,
      batchNumber: line.batchNumber,
      traceabilityPending: line.traceabilityPending,
      containerNumber: line.containerNumber,
      quantity: formatQuantityKg(line.quantityKg),
      quantityKg: Number(line.quantityKg),
      received: formatQuantityKg(line.receivedKg),
      receivedKg: Number(line.receivedKg),
      sold: formatQuantityKg(line.soldKg),
      available: formatQuantityKg(line.availableKg),
      bags: line.bags,
      outstandingKg: Math.max(0, Number(line.quantityKg) - Number(line.receivedKg)).toFixed(3),
      bagWeightKg: line.bagWeightKg.toString(),
      warehouseNames: line.warehouseNames,
    }));

    return {
      id: row.shipmentId,
      shipmentId: row.shipmentId,
      contractId: row.contractId,
      contractDate: formatDate(row.contractDate),
      contractDateSort: row.contractDate.getTime(),
      contractNumber: row.contractNumber,
      contractReference: row.contractReference,
      exporter: row.exporter,
      importer: row.importer,
      consignee: row.consignee,
      lines,
      origin: row.origin,
      destination: row.destination,
      containerNumbers: row.containerNumbers,
      containers: row.containers,
      quantity: formatQuantityKg(row.quantityKg),
      quantitySort: quantityKg,
      quantityKg,
      receivedKg,
      sold: formatQuantityKg(row.soldKg),
      available: formatQuantityKg(row.availableKg),
      bags: row.bags,
      status: row.status,
      documentStatus: row.documentStatus,
      shippingLine: row.shippingLine,
      shippingLineId: row.shippingLineId,
      bookingNumber: row.bookingNumber,
      billOfLading: row.billOfLading,
      etaDate: row.etaDate ? formatDate(row.etaDate) : '—',
      etaSort: row.etaDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
      etaIso: row.etaDate ? row.etaDate.toISOString().slice(0, 10) : null,
      portOfLoading: row.portOfLoading,
      portOfDischarge: row.portOfDischarge,
      remarks: row.remarks,
      saleStatus: row.saleStatus,
      paymentStatus: row.paymentStatus,
      fullyReceived: receivedKg > 0 && receivedKg >= quantityKg - 0.001,
      warehouseNames: row.warehouseNames,
      allocations: row.allocations.map((allocation) => ({
        customerId: allocation.customerId,
        customerName: allocation.customerName,
        invoiceId: allocation.invoiceId,
        invoiceNumber: allocation.invoiceNumber,
        invoiceDate: formatDate(allocation.invoiceDate),
        quantity: formatQuantityKg(allocation.quantityKg),
        amount: formatMoney(allocation.amount, allocation.currency),
        outstanding: formatMoney(allocation.outstanding, allocation.currency),
        settlement: allocation.settlement,
        warehouseNames: allocation.warehouseNames,
      })),
    };
  });

  const soldRows = sheet.filter((row) => row.saleStatus !== 'UNSOLD').length;

  return (
    // Landscape: fifteen columns do not fit portrait, and shrinking them until
    // they do makes the sheet unreadable.
    <div className="print-landscape space-y-6">
      <PrintHeader
        title="Loading / Contract Follow-Up"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
        period={`${rows.length} shipment${rows.length === 1 ? '' : 's'} · ${soldRows} sold or part sold`}
      />

      <PageHeader
        title="Loading Follow-Up"
        description={
          isDubai
            ? 'Every shipment from contract to consignee, in one sheet.'
            : 'Every contract from purchase to the customers it was sold to.'
        }
        breadcrumbs={[{ label: 'Trading' }, { label: 'Loading Follow-Up' }]}
        actions={<PrintButton />}
      />

      <Callout tone="info" title="One page for every live shipment">
        Approving a purchase order creates one follow-up row, even when that order has several coffees.
        Container quantity belongs to the shipment, not to each item line. Mark it loaded, update the ETA,
        Container quantity belongs to the shipment, not to each item line. After a consignment is marked loaded,
        update the document status, then mark it arrived, then receive it container by container — without opening
        the purchase order.
      </Callout>

      <LoadingSheet
        rows={rows}
        isDubai={isDubai}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
        canUpdate={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
        canReceive={can(user, PERMISSIONS.PURCHASES_APPROVE)}
        shippingLines={shippingLines}
        ports={ports.map((p) => p.name)}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))}
        defaultWarehouseId={warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? null}
      />
    </div>
  );
}
