import type { Metadata } from 'next';
import { CostingTable } from '@/components/shared/costing-table';
import { getBatchCostings } from '@/lib/services/landed-cost';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import {
  PERMISSIONS,
  SHIPMENT_STATUS_META,
  DOCUMENT_STATUS_META,
  SETTLEMENT_STATUS_META,
  INCOTERM_LABELS,
  SHIPMENT_STATUSES_LANDED,
} from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { getShipmentSettlement } from '@/lib/services/shipment';
import { getShipmentProfitabilityById } from '@/lib/services/profitability';
import { getJobCostSummary, getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getBatchStock } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg, formatQuantityMt, formatDate, formatDateTime, formatPercent, formatRate, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ShipmentWorkflow } from '@/app/(app)/shipments/[id]/shipment-workflow';
import { Plus } from 'lucide-react';

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
      purchaseContract: {
        select: {
          id: true,
          contractNumber: true,
          contractReference: true,
          currency: true,
          // Every shipment on the same order, so this one knows it is "2 of 3"
          // and the reader can step to its siblings without going back.
          shipments: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true } },
        },
      },
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

  const [settlement, profit, jobCost, costSheet, batches, shippingLines, customers, ports] = await Promise.all([
    getShipmentSettlement(prisma as never, companyId, shipment.id),
    showProfit ? getShipmentProfitabilityById(companyId, shipment.id) : Promise.resolve(null),
    showCost ? transaction((tx) => getJobCostSummary(tx, companyId, shipment.id)) : Promise.resolve(null),
    showCost ? getShipmentCostSheet(companyId, shipment.id) : Promise.resolve(null),
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
    prisma.port.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true, country: true },
    }),
  ]);

  const costing = await getBatchCostings({ companyId, shipmentId: shipment.id });

  const siblings = shipment.purchaseContract.shipments;
  const ordinal = siblings.findIndex((s) => s.id === shipment.id) + 1;
  const orderLabel = siblings.length > 1 ? `Shipment ${ordinal} of ${siblings.length}` : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={orderLabel ? `${shipment.purchaseContract.contractReference} — ${orderLabel}` : shipment.purchaseContract.contractReference}
        description={`${shipment.item.itemName} · ${shipment.vendor.vendorName}${orderLabel ? ` · one of ${siblings.length} shipments on this order` : ''}`}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Shipments', href: '/shipments' }, { label: shipment.purchaseContract.contractReference }]}
        meta={
          <>
            <StatusBadge status={shipment.status} meta={SHIPMENT_STATUS_META} />
            <StatusBadge status={shipment.documentStatus} meta={DOCUMENT_STATUS_META} />
            <StatusBadge status={settlement.status} meta={SETTLEMENT_STATUS_META} />
            <Link href={`/purchases/${shipment.purchaseContract.id}`}>
              <Badge tone="info">{shipment.purchaseContract.contractReference}</Badge>
            </Link>
            {siblings.length > 1
              ? siblings.map((sibling, index) =>
                  sibling.id === shipment.id ? (
                    <Badge key={sibling.id} tone="progress">
                      Shipment {index + 1}
                    </Badge>
                  ) : (
                    <Link key={sibling.id} href={`/shipments/${sibling.id}`}>
                      <Badge tone={SHIPMENT_STATUSES_LANDED.includes(sibling.status) ? 'success' : 'neutral'}>
                        Shipment {index + 1}
                      </Badge>
                    </Link>
                  ),
                )
              : null}
          </>
        }
        actions={
          <>
            {can(user, PERMISSIONS.EXPENSES_CREATE) ? (
              <Button asChild variant="outline">
                <Link href={`/finance/expenses/new?job=${shipment.id}`}>
                  <Plus />
                  Add shipment expense
                </Link>
              </Button>
            ) : null}
            <ShipmentWorkflow
            shipmentId={shipment.id}
            status={shipment.status}
            documentStatus={shipment.documentStatus}
            canUpdate={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
            shippingLines={shippingLines}
              ports={ports}
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
          </>
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

      {showCost && costSheet ? (
        <Card id="costing">
          <CardHeader>
            <CardTitle>Shipment costing</CardTitle>
            <CardDescription>
              Purchase cost USD + local expenses USD equivalent = total landed cost USD. Every expense keeps its own
              amount, currency and rate; {costSheet.localCurrency} totals add up those amounts, not dollars at one rate.
              {costSheet.costFx.map((pair) => (
                <span key={pair.from} className="block" data-testid="shipment-fx">
                  {pair.from} → {pair.to} weighted average over the order&rsquo;s {pair.count}{' '}
                  {pair.count === 1 ? 'transaction' : 'transactions'}: 1 {pair.from} = {Number(pair.rate).toFixed(4)} {pair.to}
                  {pair.lowest.equals(pair.highest) ? '' : ` (rates ${Number(pair.lowest).toFixed(4)} to ${Number(pair.highest).toFixed(4)})`}.
                </span>
              ))}
              Cost per KG = total landed ÷ received KG (ordered KG if nothing has landed). Cost per MT = cost per KG × 1,000.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricGrid className="lg:grid-cols-5">
              <Metric
                label="Purchase cost USD"
                value={formatMoney(costSheet.goodsUsd, 'USD')}
                hint={`${formatMoney(costSheet.goodsLocal, costSheet.localCurrency)} at the contract rate`}
              />
              <Metric
                label={`Local shipment expenses ${costSheet.localCurrency}`}
                value={formatMoney(costSheet.expenseLocal, costSheet.localCurrency)}
                hint={`${formatMoney(costSheet.expenseUsd, 'USD')} USD equivalent`}
              />
              <Metric
                label="Total landed cost USD"
                value={formatMoney(costSheet.totalShipmentCostUsd, 'USD')}
                hint={
                  costSheet.periodExpenseUsd.isZero()
                    ? formatMoney(costSheet.totalShipmentCostLocal, costSheet.localCurrency)
                    : `${formatMoney(costSheet.totalShipmentCostLocal, costSheet.localCurrency)} · leaves out ${formatMoney(costSheet.periodExpenseLocal, costSheet.localCurrency)} not added to the coffee`
                }
              />
              <Metric
                label="Received"
                value={formatQuantityKg(costSheet.receivedKg)}
                hint={
                  costSheet.receivedKg.greaterThan(0)
                    ? formatQuantityMt(costSheet.receivedKg)
                    : `Ordered ${formatQuantityKg(costSheet.orderedKg)} · ${formatQuantityMt(costSheet.orderedKg)}`
                }
              />
              <Metric
                label="Cost / MT"
                value={formatMoney(costSheet.costPerMtUsd, 'USD')}
                hint={formatMoney(costSheet.costPerMtLocal, costSheet.localCurrency)}
              />
              <Metric
                label="Cost / KG"
                value={formatMoney(costSheet.costPerKgUsd, 'USD')}
                hint={formatMoney(costSheet.costPerKgLocal, costSheet.localCurrency)}
              />
              <Metric label="Revenue" value={formatMoney(costSheet.revenueUsd, 'USD')} />
              <Metric label="COGS" value={formatMoney(costSheet.cogsUsd, 'USD')} tone="muted" />
              <Metric
                label="Gross profit"
                value={formatMoney(costSheet.grossProfitUsd, 'USD')}
                tone={costSheet.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={formatPercent(costSheet.profitPct)}
              />
              <Metric label="Remaining" value={formatQuantityKg(costSheet.remainingKg)} tone="muted" />
            </MetricGrid>

            {/* §7: where the shipment's money went, line by line. The shared
                local charges are divided equally between the item/container
                lines, and the table says so on each row. */}
            <CostingTable
              rows={costing}
              caption="Each container keeps its own purchase price; the job's shared local charges are split equally between the lines."
            />

            {costSheet.purchaseLines.length > 0 ? (
              <TableWrap>
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Coffee purchase</TH>
                      <TH numeric>Quantity</TH>
                      <TH numeric>Purchase USD</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {costSheet.purchaseLines.map((line) => (
                      <TR key={line.batchId}>
                        <TD className="font-medium">{line.batchNumber}</TD>
                        <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                        <TD numeric>{formatMoney(line.purchaseCostUsd, 'USD')}</TD>
                      </TR>
                    ))}
                  </TBody>
                  <TFoot>
                    <tr>
                      <TD>Total purchase cost</TD>
                      <TD />
                      <TD numeric>{formatMoney(costSheet.goodsUsd, 'USD')}</TD>
                    </tr>
                  </TFoot>
                </Table>
              </TableWrap>
            ) : null}

            {costSheet.lines.length > 0 ? (
              <TableWrap>
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Date</TH>
                      <TH>Expense Category</TH>
                      <TH>Memo</TH>
                      <TH>Original Currency</TH>
                      <TH numeric>Original Amount</TH>
                      <TH numeric>FX Rate</TH>
                      <TH numeric>{costSheet.localCurrency} Amount</TH>
                      <TH numeric>USD Equivalent</TH>
                      <TH>Paid / Unpaid</TH>
                      <TH>Paid From</TH>
                      <TH>Container</TH>
                      <TH>Batch</TH>
                      <TH>Reference</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {costSheet.lines.map((line) => (
                      <TR key={line.expenseId} data-testid="shipment-expense-row">
                        <TD className="text-xs">{formatDate(line.expenseDate)}</TD>
                        <TD className="font-medium">{line.category}</TD>
                        <TD className="text-xs text-ink-muted">{line.description ?? '—'}</TD>
                        <TD className="text-xs">{line.currency}</TD>
                        <TD numeric>{formatMoney(line.amount, line.currency)}</TD>
                        <TD numeric className="text-xs">{formatRate(line.rateToUsd)}</TD>
                        <TD numeric>
                          {costSheet.localCurrency === 'MAD'
                            ? formatMoney(line.amountLocal, 'MAD')
                            : formatMoney(line.amountLocal, costSheet.localCurrency)}
                        </TD>
                        <TD numeric>{formatMoney(line.amountUsd, 'USD')}</TD>
                        <TD>
                          <Badge tone={line.payment === 'PAID' ? 'success' : line.payment === 'PARTIAL' ? 'warning' : 'danger'}>
                            {line.payment === 'PAID' ? 'Paid' : line.payment === 'PARTIAL' ? 'Partially paid' : 'Unpaid'}
                          </Badge>
                        </TD>
                        <TD className="text-xs">{line.paidFrom ?? '—'}</TD>
                        <TD className="text-xs text-ink-muted">{line.containerNumber ?? 'Whole job'}</TD>
                        <TD className="text-xs text-ink-muted">{line.batchNumber ?? 'Every batch'}</TD>
                        <TD className="text-xs">{line.reference ?? '—'}</TD>
                        <TD className="text-right">
                          <Link href={`/finance/expenses/${line.expenseId}`} className="text-xs font-medium text-forest-800 hover:text-gold-700">
                            Open
                          </Link>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                  <TFoot>
                    <tr>
                      <TD colSpan={6}>Totals</TD>
                      <TD numeric>{formatMoney(costSheet.expenseLocal, costSheet.localCurrency)}</TD>
                      <TD numeric>{formatMoney(costSheet.expenseUsd, 'USD')}</TD>
                      <TD colSpan={6} />
                    </tr>
                  </TFoot>
                </Table>
              </TableWrap>
            ) : (
              <p className="text-xs text-ink-subtle">No shipment expenses posted yet. Use Add shipment expense for freight, duty, clearing, transport and commission.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

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
                    <TH>Warehouse</TH>
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
                      <TD>{b.warehouseNames || '—'}</TD>
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
                    <span className="block truncate text-sm font-medium text-forest-800">{inv.customer.customerName}</span>
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
                      {formatDate(e.expenseDate)}
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
