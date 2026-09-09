import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META, COFFEE_TYPE_LABELS, COFFEE_PROCESS_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { getBatchLocations, getStockMovements } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const batch = await prisma.batch.findUnique({ where: { id }, select: { batchNumber: true } });
  return { title: batch?.batchNumber ?? 'Batch' };
}

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const companyId = user.activeCompany.id;
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const batch = await prisma.batch.findFirst({
    where: { id, companyId },
    include: {
      item: true,
      lot: true,
      container: true,
      shipment: {
        select: { id: true, shipmentNumber: true, jobNumber: true, status: true, etaDate: true, vesselName: true },
      },
      purchaseContract: {
        select: { id: true, contractNumber: true, contractDate: true, vendor: { select: { id: true, vendorName: true } } },
      },
      invoiceLines: {
        where: { salesInvoice: { status: 'POSTED' } },
        include: {
          salesInvoice: {
            select: { id: true, invoiceNumber: true, invoiceDate: true, currency: true, customer: { select: { customerName: true } } },
          },
          warehouse: { select: { name: true } },
        },
        orderBy: { id: 'desc' },
      },
    },
  });

  if (!batch) notFound();

  const [locations, movements] = await Promise.all([
    getBatchLocations(companyId, batch.id),
    getStockMovements({ companyId, batchId: batch.id, limit: 200 }),
  ]);

  const totalOnHand = locations.reduce((a, l) => a.plus(l.onHandKg), dec(0));
  const totalAvailable = locations.reduce((a, l) => a.plus(l.availableKg), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title={batch.batchNumber}
        description={`${batch.item.itemName} · Lot ${batch.lot.lotNumber}`}
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Batch / Lot Stock', href: '/inventory/batches' },
          { label: batch.batchNumber },
        ]}
        meta={
          <>
            <Badge tone={batch.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {batch.status === 'ACTIVE' ? 'Active' : 'Closed'}
            </Badge>
            <Badge tone="neutral">{COFFEE_TYPE_LABELS[batch.item.coffeeType]}</Badge>
            {batch.container ? <Badge tone="info">{batch.container.containerNumber}</Badge> : null}
            <Link href={`/shipments/${batch.shipment.id}`}>
              <Badge tone="info">Job {batch.shipment.jobNumber}</Badge>
            </Link>
          </>
        }
      />

      <MetricGrid>
        <Metric label="Ordered" value={formatQuantityKg(batch.orderedQuantityKg)} />
        <Metric label="Received" value={formatQuantityKg(batch.receivedQuantityKg)} />
        <Metric
          label="In transit"
          value={formatQuantityKg(batch.inTransitQuantityKg)}
          tone={dec(batch.inTransitQuantityKg).greaterThan(0) ? 'muted' : 'default'}
        />
        <Metric label="Sold" value={formatQuantityKg(batch.soldQuantityKg)} />
        <Metric label="Reserved" value={formatQuantityKg(batch.allocatedQuantityKg)} tone="muted" />
        <Metric label="Available" value={formatQuantityKg(totalAvailable)} tone="positive" />
        {showCost ? (
          <>
            <Metric label="Landed cost / KG" value={formatMoney(batch.landedUnitCostUsd, 'USD')} />
            <Metric
              label="Stock value"
              value={formatMoney(totalOnHand.times(dec(batch.landedUnitCostUsd)), 'USD')}
            />
          </>
        ) : null}
      </MetricGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Where it is</CardTitle>
            <CardDescription>Stock held per warehouse.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {locations.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">
                Not yet received into a warehouse.
              </p>
            ) : (
              locations.map((l) => (
                <div key={l.warehouseId} className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{l.warehouseName}</p>
                    <p className="text-xs text-ink-subtle">
                      {l.bags.toLocaleString()} bags
                      {l.reservedKg.greaterThan(0) ? ` · ${formatQuantityKg(l.reservedKg)} reserved` : ''}
                    </p>
                  </div>
                  <p className="tnum shrink-0 text-sm font-semibold">{formatQuantityKg(l.availableKg)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Traceability</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Coffee">{batch.item.itemName}</DetailRow>
              <DetailRow label="Origin">
                {batch.item.originCountry}
                {batch.item.region ? <span className="block text-xs text-ink-subtle">{batch.item.region}</span> : null}
              </DetailRow>
              <DetailRow label="Grade / screen">
                {[batch.item.grade, batch.item.screenSize].filter(Boolean).join(' · ') || '—'}
              </DetailRow>
              <DetailRow label="Process">{COFFEE_PROCESS_LABELS[batch.item.process]}</DetailRow>
              <DetailRow label="Crop year">{batch.item.cropYear ?? '—'}</DetailRow>
              <DetailRow label="Lot">{batch.lot.lotNumber}</DetailRow>
              <DetailRow label="Container">
                {batch.container ? `${batch.container.containerNumber} (${batch.container.containerType})` : '—'}
              </DetailRow>
              <DetailRow label="Bag weight">{formatQuantityKg(batch.bagWeightKg)}</DetailRow>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Origin documents</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Contract">
                <Link href={`/purchases/${batch.purchaseContract.id}`} className="text-teal-700 hover:underline">
                  {batch.purchaseContract.contractNumber}
                </Link>
              </DetailRow>
              <DetailRow label="Supplier">
                <Link href={`/vendors/${batch.purchaseContract.vendor.id}`} className="text-teal-700 hover:underline">
                  {batch.purchaseContract.vendor.vendorName}
                </Link>
              </DetailRow>
              <DetailRow label="Contract date">{formatDate(batch.purchaseContract.contractDate)}</DetailRow>
              <DetailRow label="Shipment">
                <Link href={`/shipments/${batch.shipment.id}`} className="text-teal-700 hover:underline">
                  {batch.shipment.shipmentNumber}
                </Link>
              </DetailRow>
              <DetailRow label="Shipment status">
                <StatusBadge status={batch.shipment.status} meta={SHIPMENT_STATUS_META} />
              </DetailRow>
              <DetailRow label="Vessel">{batch.shipment.vesselName ?? '—'}</DetailRow>
              <DetailRow label="ETA">{formatDate(batch.shipment.etaDate)}</DetailRow>
              {showCost ? (
                <>
                  <DetailRow label="Goods cost">{formatMoney(batch.purchaseCostUsd, 'USD')}</DetailRow>
                  <DetailRow label="Capitalised costs">{formatMoney(batch.capitalisedCostUsd, 'USD')}</DetailRow>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      {batch.invoiceLines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Sold to</CardTitle>
            <CardDescription>A batch can be split across several customers.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Invoice</TH>
                    <TH>Customer</TH>
                    <TH>Date</TH>
                    <TH>From</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Value</TH>
                  </TR>
                </THead>
                <TBody>
                  {batch.invoiceLines.map((line) => (
                    <TR key={line.id}>
                      <TD>
                        <Link href={`/sales/${line.salesInvoice.id}`} className="font-medium text-navy-800 hover:text-teal-700">
                          {line.salesInvoice.invoiceNumber}
                        </Link>
                      </TD>
                      <TD>{line.salesInvoice.customer.customerName}</TD>
                      <TD>{formatDate(line.salesInvoice.invoiceDate)}</TD>
                      <TD className="text-xs">{line.warehouse?.name ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                      <TD numeric>{formatMoney(line.lineTotal, line.salesInvoice.currency)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Movement history</CardTitle>
          <CardDescription>Every kilogram in and out of this batch.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Date</TH>
                  <TH>Movement</TH>
                  <TH>Reference</TH>
                  <TH numeric>Quantity</TH>
                  <TH>Notes</TH>
                  <TH>By</TH>
                </TR>
              </THead>
              <TBody>
                {movements.map((m) => (
                  <TR key={m.id}>
                    <TD>{formatDate(m.transactionDate)}</TD>
                    <TD>{titleCase(m.transactionType)}</TD>
                    <TD className="text-xs">{m.referenceLabel ?? titleCase(m.referenceType)}</TD>
                    <TD numeric className={m.quantityKg.greaterThan(0) ? 'text-teal-700' : 'text-navy-700'}>
                      {m.quantityKg.greaterThan(0) ? '+' : ''}
                      {formatQuantityKg(m.quantityKg)}
                    </TD>
                    <TD className="text-xs text-ink-muted">{m.notes ?? '—'}</TD>
                    <TD className="text-xs">
                      {m.createdBy}
                      <span className="block text-ink-subtle">{formatDateTime(m.createdAt)}</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
