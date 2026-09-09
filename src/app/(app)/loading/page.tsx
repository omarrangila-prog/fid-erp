import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { formatQuantityKg, formatDate, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Callout } from '@/components/ui/feedback';
import { LoadingSheet, type LoadingRow } from '@/app/(app)/loading/loading-sheet';

export const metadata: Metadata = { title: 'Loading Follow-Up' };
export const dynamic = 'force-dynamic';

export default async function LoadingPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const sheet = await getLoadingSheet(user.activeCompany.id);

  // Dubai trades container to container; Morocco buys a container and sells it
  // to many customers. The two paper sheets differ, so the two screens do too.
  const isDubai = user.activeCompany.localCurrency === 'AED';

  const rows: LoadingRow[] = sheet.map((row, index) => ({
    id: row.batchId,
    serial: index + 1,
    shipmentId: row.shipmentId,
    contractId: row.contractId,
    contractDate: formatDate(row.contractDate),
    contractDateSort: row.contractDate.getTime(),
    contractNumber: row.contractNumber,
    contractReference: row.contractReference,
    exporter: row.exporter,
    importer: row.importer,
    consignee: row.consignee,
    itemName: row.itemName,
    origin: row.origin,
    destination: row.destination,
    lotNumber: row.lotNumber,
    batchNumber: row.batchNumber,
    containerNumber: row.containerNumber,
    containers: row.containers,
    quantity: formatQuantityKg(row.quantityKg),
    quantitySort: Number(row.quantityKg),
    sold: formatQuantityKg(row.soldKg),
    available: formatQuantityKg(row.availableKg),
    bags: row.bags,
    status: row.status,
    documentStatus: row.documentStatus,
    shippingLine: row.shippingLine,
    bookingNumber: row.bookingNumber,
    billOfLading: row.billOfLading,
    etaDate: row.etaDate ? formatDate(row.etaDate) : '—',
    etaSort: row.etaDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
    remarks: row.remarks,
    saleStatus: row.saleStatus,
    paymentStatus: row.paymentStatus,
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
    })),
  }));

  const soldRows = sheet.filter((row) => row.saleStatus !== 'UNSOLD').length;

  return (
    // Landscape: fifteen columns do not fit portrait, and shrinking them until
    // they do makes the sheet unreadable.
    <div className="print-landscape space-y-6">
      <PrintHeader
        title="Loading / Contract Follow-Up"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
        period={`${rows.length} container${rows.length === 1 ? '' : 's'} · ${soldRows} sold or part sold`}
      />

      <PageHeader
        title="Loading Follow-Up"
        description={
          isDubai
            ? 'Every container from contract to consignee, in one sheet.'
            : 'Every contract from purchase to the customers it was sold to.'
        }
        breadcrumbs={[{ label: 'Trading' }, { label: 'Loading Follow-Up' }]}
        actions={<PrintButton />}
      />

      <Callout tone="info" title="Nothing on this sheet is typed twice">
        Every column is read from the document that already holds it. Approving a purchase contract creates the row;
        entering a bill of lading or an ETA on the shipment fills those columns; posting a sale fills in the consignee
        and moves the sold figures; receiving a payment moves the payment status.{' '}
        {isDubai
          ? 'Sold or unsold is arithmetic on the container, not a label anyone maintains.'
          : 'A contract sold to several customers stays one row, with every customer listed underneath it.'}
      </Callout>

      <LoadingSheet rows={rows} isDubai={isDubai} canExport={can(user, PERMISSIONS.REPORTS_EXPORT)} />
    </div>
  );
}
