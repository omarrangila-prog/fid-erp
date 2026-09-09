import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import {
  PERMISSIONS,
  SHIPMENT_STATUS_META,
  DOCUMENT_STATUS_META,
  SETTLEMENT_STATUS_META,
  INCOTERM_LABELS,
} from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { getShipmentSettlement } from '@/lib/services/shipment';
import { getShipmentProfitabilityById } from '@/lib/services/profitability';
import { getJobCostSummary } from '@/lib/services/landed-cost';
import { getBatchStock } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, formatPercent, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ShipmentWorkflow } from '@/app/(app)/shipments/[id]/shipment-workflow';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const shipment = await prisma.shipment.findUnique({ where: { id }, select: { shipmentNumber: true } });
  return { title: shipment?.shipmentNumber ?? 'Shipment' };
}

export default async function ShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;
  const showProfit = can(user, PERMISSIONS.PROFITS_VIEW);
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const shipment = await prisma.shipment.findFirst({
    where: { id, companyId },
    include: {
      purchaseContract: { select: { id: true, contractNumber: true, contractReference: true, currency: true } },
      vendor: { select: { id: true, vendorName: true } },
      customer: { select: { id: true, customerName: true } },
      item: { select: { itemName: true, originCountry: true, grade: true } },
      shippingLine: { select: { id: true, name: true } },
      containerList: { orderBy: { containerNumber: 'asc' } },
      statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true } } } },
      docStatusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true } } } },
      salesInvoices: {
        where: { status: 'POSTED' },
        include: { customer: { select: { customerName: true } } },
        orderBy: { invoiceDate: 'desc' },
      },
      expenses: {
        where: { status: 'POSTED' },
        include: { expenseCategory: { select: { name: true } } },
        orderBy: { expenseDate: 'desc' },
      },
    },
  });

  if (!shipment) notFound();

  const [settlement, profit, jobCost, batches, shippingLines, customers] = await Promise.all([
    getShipmentSettlement(prisma as never, companyId, shipment.id),
    showProfit ? getShipmentProfitabilityById(companyId, shipment.id) : Promise.resolve(null),
    showCost ? transaction((tx) => getJobCostSummary(tx, companyId, shipment.id)) : Promise.resolve(null),
    getBatchStock({ companyId, shipmentId: shipment.id, includeEmpty: true }),
    prisma.shippingLine.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={shipment.shipmentNumber}
        description={`${shipment.item.itemName} · ${shipment.vendor.vendorName}`}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Shipments', href: '/shipments' }, { label: shipment.shipmentNumber }]}
        meta={
          <>
            <StatusBadge status={shipment.status} meta={SHIPMENT_STATUS_META} />
            <StatusBadge status={shipment.documentStatus} meta={DOCUMENT_STATUS_META} />
            <StatusBadge status={settlement.status} meta={SETTLEMENT_STATUS_META} />
            <Badge tone="neutral">Job {shipment.jobNumber}</Badge>
            <Link href={`/purchases/${shipment.purchaseContract.id}`}>
              <Badge tone="info">{shipment.purchaseContract.contractNumber}</Badge>
            </Link>
          </>
        }
        actions={
          <ShipmentWorkflow
            shipmentId={shipment.id}
            status={shipment.status}
            documentStatus={shipment.documentStatus}
            canUpdate={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
            shippingLines={shippingLines}
            customers={customers.map((c) => ({ id: c.id, name: c.customerName }))}
            values={{
              bookingNumber: shipment.bookingNumber ?? '',
              billOfLading: shipment.billOfLading ?? '',
              vesselName: shipment.vesselName ?? '',
              voyageNumber: shipment.voyageNumber ?? '',
              portOfLoading: shipment.portOfLoading ?? '',
              portOfDischarge: shipment.portOfDischarge ?? '',
              shippingLineId: shipment.shippingLineId ?? '',
              etdDate: toDateInputValue(shipment.etdDate),
              etaDate: toDateInputValue(shipment.etaDate),
              ataDate: toDateInputValue(shipment.ataDate),
              loadingDate: toDateInputValue(shipment.loadingDate),
              clearanceDate: toDateInputValue(shipment.clearanceDate),
              deliveryDate: toDateInputValue(shipment.deliveryDate),
              destination: shipment.destination ?? '',
              customerId: shipment.customerId ?? '',
              containers: String(shipment.containers),
            }}
          />
        }
      />

      <MetricGrid>
        <Metric label="Quantity" value={formatQuantityKg(shipment.quantityKg)} hint={`${shipment.bags.toLocaleString()} bags`} />
        <Metric label="Containers" value={String(shipment.containers)} />
        <Metric label="ETA" value={formatDate(shipment.etaDate)} hint={shipment.vesselName ?? undefined} />
        <Metric label="Invoiced" value={formatMoney(settlement.invoicedUsd, 'USD')} />
        <Metric
          label="Received"
          value={formatMoney(settlement.receivedUsd, 'USD')}
          tone={settlement.receivedUsd.greaterThan(0) ? 'positive' : 'muted'}
        />
        <Metric
          label="Outstanding"
          value={formatMoney(settlement.outstandingUsd, 'USD')}
          tone={settlement.outstandingUsd.greaterThan(0) ? 'negative' : 'positive'}
        />
      </MetricGrid>

      {showProfit && profit ? (
        <Card>
          <CardHeader>
            <CardTitle>Job profitability</CardTitle>
            <CardDescription>
              Only the coffee that has actually sold counts. Unsold stock stays on the balance sheet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MetricGrid className="lg:grid-cols-5">
              <Metric label="Sold" value={formatQuantityKg(profit.soldQuantityKg)} />
              <Metric label="Remaining" value={formatQuantityKg(profit.remainingQuantityKg)} tone="muted" />
              <Metric label="Sales revenue" value={formatMoney(profit.salesRevenueUsd, 'USD')} />
              <Metric label="Landed cost of sales" value={formatMoney(profit.allocatedLandedCostUsd, 'USD')} tone="muted" />
              <Metric
                label="Gross profit"
                value={formatMoney(profit.grossProfitUsd, 'USD')}
                tone={profit.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={`${formatPercent(profit.grossMarginPct)} margin`}
              />
              <Metric label="Period costs" value={formatMoney(profit.otherCostsUsd, 'USD')} tone="muted" />
              <Metric
                label="Net profit"
                value={formatMoney(profit.netProfitUsd, 'USD')}
                tone={profit.netProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={`${formatPercent(profit.netMarginPct)} margin`}
              />
              <Metric label="Profit per KG" value={formatMoney(profit.profitPerKgUsd, 'USD')} />
              {jobCost ? (
                <>
                  <Metric label="Landed cost / KG" value={formatMoney(jobCost.landedCostPerKgUsd, 'USD')} />
                  <Metric label="Landed cost / bag" value={formatMoney(jobCost.landedCostPerBagUsd, 'USD')} />
                </>
              ) : null}
            </MetricGrid>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Batches and containers</CardTitle>
            <CardDescription>Traceability from lot to container to warehouse.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Batch</TH>
                    <TH>Lot</TH>
                    <TH>Container</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Sold</TH>
                    <TH numeric>Available</TH>
                    {showCost ? <TH numeric>Landed / KG</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {batches.map((b) => (
                    <TR key={b.batchId}>
                      <TD className="font-medium">
                        <Link href={`/inventory/batches/${b.batchId}`} className="text-forest-800 hover:text-gold-700">
                          {b.batchNumber}
                        </Link>
                      </TD>
                      <TD>{b.lotNumber}</TD>
                      <TD className="text-xs">{b.containerNumber ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(b.receivedKg)}</TD>
                      <TD numeric>{formatQuantityKg(b.soldKg)}</TD>
                      <TD numeric className="font-medium">{formatQuantityKg(b.availableKg)}</TD>
                      {showCost ? <TD numeric>{formatMoney(b.unitCostUsd, 'USD')}</TD> : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Logistics</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Supplier">
                <Link href={`/vendors/${shipment.vendor.id}`} className="text-gold-700 hover:underline">
                  {shipment.vendor.vendorName}
                </Link>
              </DetailRow>
              <DetailRow label="Buyer">
                {shipment.customer ? (
                  <Link href={`/customers/${shipment.customer.id}`} className="text-gold-700 hover:underline">
                    {shipment.customer.customerName}
                  </Link>
                ) : (
                  <span className="text-ink-subtle">Not yet sold</span>
                )}
              </DetailRow>
              <DetailRow label="Incoterm">{INCOTERM_LABELS[shipment.incoterm] ?? shipment.incoterm}</DetailRow>
              <DetailRow label="Shipping line">{shipment.shippingLine?.name ?? '—'}</DetailRow>
              <DetailRow label="Booking">{shipment.bookingNumber ?? '—'}</DetailRow>
              <DetailRow label="Bill of lading">{shipment.billOfLading ?? '—'}</DetailRow>
              <DetailRow label="Vessel">
                {shipment.vesselName ?? '—'}
                {shipment.voyageNumber ? (
                  <span className="block text-xs text-ink-subtle">Voyage {shipment.voyageNumber}</span>
                ) : null}
              </DetailRow>
              <DetailRow label="Port of loading">{shipment.portOfLoading ?? '—'}</DetailRow>
              <DetailRow label="Port of discharge">{shipment.portOfDischarge ?? '—'}</DetailRow>
              <DetailRow label="ETD">{formatDate(shipment.etdDate)}</DetailRow>
              <DetailRow label="ETA">{formatDate(shipment.etaDate)}</DetailRow>
              <DetailRow label="Arrived">{formatDate(shipment.ataDate)}</DetailRow>
              <DetailRow label="Cleared">{formatDate(shipment.clearanceDate)}</DetailRow>
              <DetailRow label="Delivered">{formatDate(shipment.deliveryDate)}</DetailRow>
            </dl>

            {shipment.containerList.length > 0 ? (
              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Containers</p>
                <ul className="space-y-1">
                  {shipment.containerList.map((c) => (
                    <li key={c.id} className="flex items-center justify-between text-xs">
                      <span className="font-medium text-ink">{c.containerNumber}</span>
                      <span className="text-ink-subtle">
                        {c.containerType} · {formatQuantityKg(c.netWeightKg)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sales against this job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {shipment.salesInvoices.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">Nothing sold from this job yet.</p>
            ) : (
              shipment.salesInvoices.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/sales/${inv.id}`}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-forest-800">{inv.invoiceNumber}</span>
                    <span className="block truncate text-xs text-ink-subtle">
                      {inv.customer.customerName} · {formatDate(inv.invoiceDate)}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-sm font-semibold">
                    {formatMoney(inv.totalAmount, inv.currency)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Job costs</CardTitle>
            <CardDescription>Capitalised costs raise the landed cost; period costs reduce net profit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {shipment.expenses.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">No costs booked to this job yet.</p>
            ) : (
              shipment.expenses.map((e) => (
                <Link
                  key={e.id}
                  href={`/finance/expenses/${e.id}`}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-forest-800">
                      {e.expenseCategory.name}
                    </span>
                    <span className="block truncate text-xs text-ink-subtle">
                      {e.expenseNumber} · {formatDate(e.expenseDate)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tnum block text-sm font-semibold">{formatMoney(e.amount, e.currency)}</span>
                    <Badge tone={e.capitaliseToLandedCost ? 'info' : 'neutral'}>
                      {e.capitaliseToLandedCost ? 'Landed cost' : 'Period cost'}
                    </Badge>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every status change, who made it and when.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {[...shipment.statusHistory.map((h) => ({ ...h, kind: 'status' as const })),
            ...shipment.docStatusHistory.map((h) => ({ ...h, kind: 'document' as const }))]
            .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
            .map((entry) => (
              <div key={`${entry.kind}-${entry.id}`} className="flex items-start gap-3 border-b border-line pb-2 last:border-0">
                <StatusBadge
                  status={entry.toStatus}
                  meta={entry.kind === 'status' ? SHIPMENT_STATUS_META : DOCUMENT_STATUS_META}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink-muted">
                    {entry.kind === 'document' ? 'Documents · ' : ''}
                    {entry.changedBy.name} · {formatDateTime(entry.changedAt)}
                  </p>
                  {entry.notes ? <p className="text-xs text-ink">{entry.notes}</p> : null}
                </div>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
