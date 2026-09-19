import type { Metadata } from 'next';
import { CostingTable } from '@/components/shared/costing-table';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { DocumentJournal } from '@/components/shared/document-journal';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, INCOTERM_LABELS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec } from '@/lib/money';
import { getReceiptStatus } from '@/lib/services/purchase';
import { getContractOutstanding } from '@/lib/services/payment';
import { supplierGrossPayable } from '@/lib/services/tax';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { AttachmentPanel } from '@/components/attachments/attachment-panel';
import { loadAttachments } from '@/components/attachments/load';
import { PurchaseDetailToolbar } from '@/app/(app)/purchases/[id]/detail-toolbar';
import { getWarehouseLabels } from '@/lib/services/stock';
import { getOrderOverview } from '@/lib/services/shipment';
import { OrderShipments } from '@/app/(app)/purchases/[id]/order-shipments';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const contract = await prisma.purchaseContract.findUnique({
    where: { id },
    select: { contractNumber: true },
  });
  return { title: contract?.contractNumber ?? 'Purchase Contract' };
}

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.PURCHASES_VIEW);
  const companyId = user.activeCompany.id;
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const contract = await prisma.purchaseContract.findFirst({
    where: { id, companyId },
    include: {
      vendor: true,
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      lines: { orderBy: { lineNumber: 'asc' }, include: { item: true } },
      shipments: { select: { id: true, shipmentNumber: true, jobNumber: true, status: true, etaDate: true } },
      goodsReceipts: {
        orderBy: { receiptDate: 'desc' },
        include: { warehouse: { select: { name: true } }, lines: { select: { quantityKg: true } } },
      },
    },
  });

  if (!contract) notFound();

  const attachments = can(user, PERMISSIONS.ATTACHMENTS_VIEW)
    ? await loadAttachments(user.activeCompany.id, 'PurchaseContract', contract.id)
    : [];

  const [receiptStatus, outstanding, warehouses, warehouseLabels, order] = await Promise.all([
    transaction((tx) => getReceiptStatus(tx, contract.id)),
    contract.status === 'POSTED'
      ? transaction((tx) => getContractOutstanding(tx, contract.id))
      : Promise.resolve(null),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, isDefault: true },
    }),
    getWarehouseLabels(companyId),
    contract.shipments.length > 0 ? getOrderOverview(companyId, contract.id) : Promise.resolve(null),
  ]);

  const warehouseByLineId = new Map(
    receiptStatus.map((row) => [row.lineId, warehouseLabels.byBatch.get(row.batchId) || '—']),
  );
  const totalOrdered = receiptStatus.reduce((a, r) => a.plus(r.orderedKg), dec(0));
  const totalReceived = receiptStatus.reduce((a, r) => a.plus(r.receivedKg), dec(0));
  const fullyReceived = totalOrdered.greaterThan(0) && totalReceived.greaterThanOrEqualTo(totalOrdered);
  // Which shipment each batch sails in, for the receipt dialog's labels. On
  // an order opened under the current rule that is one per line; an older
  // job carries all its batches on one shipment, and says so.
  const shipmentOrdinalByBatch = new Map(
    (order?.shipments ?? []).flatMap((line) => (line.batchId ? [[line.batchId, line.ordinal] as const] : [])),
  );
  const supplierPayable = supplierGrossPayable({
    netAmount: contract.totalValue,
    taxAmount: contract.taxAmount,
    vendorCountry: contract.vendor.country,
    companyCountry: user.activeCompany.country,
  });

  // §12: what this order's coffee is costing, on the order itself.
  const costing = await getBatchCostings({
    companyId: user.activeCompany.id,
    batchIds: receiptStatus.map((r) => r.batchId),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={contract.contractReference}
        description={`${contract.vendor.vendorName} · ${contract.contractReference}`}
        breadcrumbs={[
          { label: 'Trading' },
          { label: 'Purchase Contracts', href: '/purchases' },
          { label: contract.contractNumber },
        ]}
        meta={
          <>
            <StatusBadge status={contract.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone="neutral">{contract.currency}</Badge>
            <Badge tone="neutral">{INCOTERM_LABELS[contract.incoterm]?.split(' — ')[0] ?? contract.incoterm}</Badge>
            {order ? (
              <Badge tone={order.arrival === 'FULLY_ARRIVED' ? 'success' : order.arrival === 'PARTIALLY_ARRIVED' ? 'warning' : 'info'}>
                {order.arrivedContainers} of {order.containerCount} containers arrived
              </Badge>
            ) : null}
          </>
        }
        actions={
          <PurchaseDetailToolbar
            id={contract.id}
            contractLabel={contract.contractReference}
            status={contract.status}
            permissions={{
              approve: can(user, PERMISSIONS.PURCHASES_APPROVE),
              edit: can(user, PERMISSIONS.PURCHASES_EDIT),
              delete: can(user, PERMISSIONS.PURCHASES_DELETE),
              reverse: can(user, PERMISSIONS.PURCHASES_REVERSE),
              receive: can(user, PERMISSIONS.PURCHASES_APPROVE),
            }}
            fullyReceived={fullyReceived}
            batches={receiptStatus.map((r) => ({
              batchId: r.batchId,
              batchNumber: r.batchNumber,
              shipmentOrdinal: shipmentOrdinalByBatch.get(r.batchId) ?? r.lineNumber,
              arrived: r.arrived,
              containerNumbers: r.containerNumbers,
              itemName: r.itemName,
              lotNumber: r.lotNumber,
              containerNumber: r.containerNumber,
              orderedKg: r.orderedKg.toString(),
              receivedKg: r.receivedKg.toString(),
              outstandingKg: r.outstandingKg.toString(),
              bagWeightKg: r.bagWeightKg.toString(),
              traceabilityPending: r.traceabilityPending,
            }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))}
            defaultWarehouseId={warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? null}
          />
        }
      />

      {contract.status === 'REVERSED' ? (
        <Callout tone="danger" title="This contract was deleted">
          {contract.reversalReason} — deleted {formatDateTime(contract.reversedAt)}.
        </Callout>
      ) : null}

      {contract.status === 'POSTED' && !fullyReceived ? (
        <Callout tone="warning" title="Coffee is still in transit">
          {formatQuantityKg(totalOrdered.minus(totalReceived))} of {formatQuantityKg(totalOrdered)} has not yet been
          received into a warehouse, so it cannot be sold. Use <strong>Receive goods</strong> when it lands.
        </Callout>
      ) : null}

      <MetricGrid>
        <Metric label="Quantity" value={formatQuantityKg(totalOrdered)} />
        <Metric label="Bags" value={contract.totalBags.toLocaleString()} />
        <Metric label="Containers" value={String(contract.containers)} />
        <Metric
          label="Received"
          value={formatQuantityKg(totalReceived)}
          tone={fullyReceived ? 'positive' : 'muted'}
          hint={fullyReceived ? 'Fully received' : `${formatQuantityKg(totalOrdered.minus(totalReceived))} outstanding`}
        />
        {showCost ? (
          <>
            <Metric label="Goods value" value={formatMoney(contract.subtotal, contract.currency)} />
            <Metric
              label="Freight + charges"
              value={formatMoney(dec(contract.freightAmount).plus(dec(contract.otherCharges)), contract.currency)}
            />
            <Metric label="Contract value" value={formatMoney(contract.totalValue, contract.currency)} />
            <Metric
              label="Posted to supplier"
              value={formatMoney(supplierPayable.amount, contract.currency)}
              hint={
                supplierPayable.taxOnSupplierInvoice
                  ? 'Goods + freight + tax billed by this supplier.'
                  : 'Contract value. Import tax is not owed to this supplier.'
              }
            />
            {outstanding ? (
              <Metric
                label="Still owed"
                value={formatMoney(outstanding.amount, contract.currency)}
                tone={outstanding.amount.greaterThan(0) ? 'negative' : 'positive'}
              />
            ) : null}
          </>
        ) : null}
      </MetricGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Containers ordered</CardTitle>
            <CardDescription>What the supplier sold, container by container — each with its own lot and batch, received and sold separately.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>#</TH>
                    <TH>Coffee</TH>
                    <TH>Lot / Batch</TH>
                    <TH>Container</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Bags</TH>
                    {showCost ? (
                      <>
                        <TH numeric>Price</TH>
                        <TH numeric>Goods</TH>
                        <TH numeric>Cost / KG</TH>
                      </>
                    ) : null}
                  </TR>
                </THead>
                <TBody>
                  {contract.lines.map((line) => (
                    <TR key={line.id}>
                      <TD className="text-ink-subtle">{line.lineNumber}</TD>
                      <TD>
                        <span className="block font-medium">{line.item.itemName}</span>
                        <span className="block text-xs text-ink-subtle">
                          {line.item.originCountry}
                          {line.item.grade ? ` · ${line.item.grade}` : ''}
                        </span>
                      </TD>
                      <TD>
                        <span className="block">{line.lotNumber}</span>
                        <span className="block text-xs text-ink-subtle">{line.batchNumber}</span>
                      </TD>
                      <TD className="text-xs">{line.containerNumber ?? '—'}</TD>
                      <TD className="text-xs">
                        {warehouseByLineId.get(line.id) || warehouseLabels.byContract.get(contract.id) || '—'}
                      </TD>
                      <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                      <TD numeric>{line.bags.toLocaleString()}</TD>
                      {showCost ? (
                        <>
                          <TD numeric>
                            {formatMoney(line.unitPrice, contract.currency)}
                            <span className="block text-xs text-ink-subtle">per {line.unit}</span>
                          </TD>
                          <TD numeric>{formatMoney(line.lineSubtotal, contract.currency)}</TD>
                          <TD numeric className="font-medium text-gold-700">
                            {formatMoney(line.unitCostKg, contract.currency)}
                          </TD>
                        </>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
                {showCost ? (
                  <TFoot>
                    <tr>
                      <TD colSpan={4}>Total</TD>
                      <TD numeric>{formatQuantityKg(totalOrdered)}</TD>
                      <TD numeric>{contract.totalBags.toLocaleString()}</TD>
                      <TD />
                      <TD numeric>{formatMoney(contract.subtotal, contract.currency)}</TD>
                      <TD />
                    </tr>
                  </TFoot>
                ) : null}
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Contract detail</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <DetailRow label="Supplier">
                  <Link href={`/vendors/${contract.vendorId}`} className="text-gold-700 hover:underline">
                    {contract.vendor.vendorName}
                  </Link>
                </DetailRow>
                <DetailRow label="Supplier contract">{contract.supplierContractNo ?? '—'}</DetailRow>
                <DetailRow label="Contract date">{formatDate(contract.contractDate)}</DetailRow>
                <DetailRow label="Expected shipment">{formatDate(contract.expectedShipmentDate)}</DetailRow>
                <DetailRow label="Origin">{contract.origin ?? '—'}</DetailRow>
                <DetailRow label="Port of loading">{contract.portOfLoading ?? '—'}</DetailRow>
                <DetailRow label="Destination">{contract.destination ?? '—'}</DetailRow>
                <DetailRow label="Incoterm">{INCOTERM_LABELS[contract.incoterm] ?? contract.incoterm}</DetailRow>
                <DetailRow label="Due date">{formatDate(contract.dueDate)}</DetailRow>
                {showCost ? (
                  <>
                    <DetailRow label="Rate to USD">{formatRate(contract.rateToUsd)}</DetailRow>
                    <DetailRow label={`Rate to ${user.activeCompany.localCurrency}`}>
                      {formatRate(contract.rateLocalPerUsd)}
                    </DetailRow>
                    <DetailRow label="Value in USD">{formatMoney(contract.totalValueUsd, 'USD')}</DetailRow>
                  </>
                ) : null}
                <DetailRow label="Created by">{contract.createdBy.name}</DetailRow>
                {contract.postedBy ? (
                  <DetailRow label="Approved by">
                    {contract.postedBy.name}
                    <span className="block text-xs text-ink-subtle">{formatDateTime(contract.postedAt)}</span>
                  </DetailRow>
                ) : null}
              </dl>
              {contract.notes ? (
                <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-xs text-ink-muted">
                  {contract.notes}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {order ? (
            <Card>
              <CardHeader>
                <CardTitle>Order status</CardTitle>
                <CardDescription>Costs and sales roll up to this order.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Containers">{order.containerCount}</DetailRow>
                  <DetailRow label="Arrived">
                    {order.arrivedContainers} of {order.containerCount} containers
                  </DetailRow>
                  <DetailRow label="Received">
                    {order.receivedContainers} of {order.containerCount} containers
                  </DetailRow>
                  {order.totalShipments !== order.containerCount ? (
                    <DetailRow label="Shipments">{order.totalShipments}</DetailRow>
                  ) : null}
                  <DetailRow label="Total quantity">{formatQuantityKg(order.totalKg)}</DetailRow>
                  {showCost ? (
                    <DetailRow label="Purchase value">{formatMoney(order.totalPurchaseUsd, 'USD')}</DetailRow>
                  ) : null}
                  <DetailRow label="Arrival">
                    <Badge tone={order.arrival === 'FULLY_ARRIVED' ? 'success' : order.arrival === 'PARTIALLY_ARRIVED' ? 'warning' : 'neutral'}>
                      {order.arrival === 'FULLY_ARRIVED' ? 'Fully arrived' : order.arrival === 'PARTIALLY_ARRIVED' ? 'Partially arrived' : 'Not arrived'}
                    </Badge>
                  </DetailRow>
                  <DetailRow label="Receipt">
                    <Badge tone={order.receipt === 'FULLY_RECEIVED' ? 'success' : order.receipt === 'PARTIALLY_RECEIVED' ? 'warning' : 'neutral'}>
                      {order.receipt === 'FULLY_RECEIVED' ? 'Fully received' : order.receipt === 'PARTIALLY_RECEIVED' ? 'Partially received' : 'Not received'}
                    </Badge>
                  </DetailRow>
                </dl>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {order ? (
        <OrderShipments
          contractId={contract.id}
          canMarkArrived={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
          canReceive={contract.status === 'POSTED' && can(user, PERMISSIONS.PURCHASES_APPROVE)}
          summary={{
            reference: order.reference,
            totalShipments: order.totalShipments,
            arrivedCount: order.arrivedCount,
            receivedCount: order.receivedCount,
            containerCount: order.containerCount,
            arrivedContainers: order.arrivedContainers,
            receivedContainers: order.receivedContainers,
            totalKg: formatQuantityKg(order.totalKg),
            receivedKg: formatQuantityKg(order.receivedKg),
            remainingKg: formatQuantityKg(order.remainingKg),
            totalPurchaseUsd: showCost ? formatMoney(order.totalPurchaseUsd, 'USD') : '—',
            arrival: order.arrival,
            receipt: order.receipt,
          }}
          rows={order.shipments.map((line) => ({
            shipmentId: line.shipmentId,
            ordinal: line.ordinal,
            batchOrdinal: line.batchOrdinal,
            batchesOnShipment: line.batchesOnShipment,
            stage: line.stage,
            status: line.status,
            arrived: line.arrived,
            received: line.received,
            itemName: line.itemName,
            containerNumber: line.containerNumber,
            lotNumber: line.lotNumber,
            batchNumber: line.batchNumber,
            batchId: line.batchId,
            warehouseName: line.warehouseName,
            orderedKg: formatQuantityKg(line.orderedKg),
            receivedKg: formatQuantityKg(line.receivedKg),
            availableKg: formatQuantityKg(line.availableKg),
            purchaseUsd: showCost ? formatMoney(line.purchaseUsd, 'USD') : '—',
            etaDate: line.etaDate ? formatDate(line.etaDate) : null,
            ataDate: line.ataDate ? formatDate(line.ataDate) : null,
          }))}
        />
      ) : null}

      {contract.status === 'POSTED' ? (
        <Card>
          <CardHeader>
            {costing.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>What this coffee is costing</CardTitle>
              <CardDescription>
                The supplier&rsquo;s price for each container, plus that container&rsquo;s share of the job&rsquo;s
                local charges. It updates by itself as shipment costs are booked.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <CostingTable rows={costing} />
            </CardContent>
          </Card>
        ) : null}

        <CardTitle>Receiving progress</CardTitle>
            <CardDescription>What has physically landed, batch by batch.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Batch</TH>
                    <TH>Coffee</TH>
                    <TH>Lot</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Ordered</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Outstanding</TH>
                  </TR>
                </THead>
                <TBody>
                  {receiptStatus.map((r) => (
                    <TR key={r.batchId}>
                      <TD className="font-medium">{r.batchNumber}</TD>
                      <TD>{r.itemName}</TD>
                      <TD>{r.lotNumber}</TD>
                      <TD>{warehouseLabels.byBatch.get(r.batchId) || '—'}</TD>
                      <TD numeric>{formatQuantityKg(r.orderedKg)}</TD>
                      <TD numeric>{formatQuantityKg(r.receivedKg)}</TD>
                      <TD numeric className={r.outstandingKg.greaterThan(0) ? 'font-medium text-amber-700' : 'text-gold-700'}>
                        {r.outstandingKg.greaterThan(0) ? formatQuantityKg(r.outstandingKg) : 'Complete'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>

            {contract.goodsReceipts.length > 0 ? (
              <div className="space-y-2 border-t border-line px-5 py-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Goods receipts</h4>
                {contract.goodsReceipts.map((grn) => (
                  <div key={grn.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      <span className="font-medium text-ink">Received {formatDate(grn.receiptDate)}</span>
                      <span className="ml-2 text-xs text-ink-subtle">{grn.warehouse.name}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tnum text-xs text-ink-muted">
                        {formatQuantityKg(grn.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0)))}
                      </span>
                      <StatusBadge status={grn.status} meta={TRANSACTION_STATUS_META} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="max-w-md">
        <DocumentJournal
          companyId={user.activeCompany.id}
          sourceType="PURCHASE_CONTRACT"
          sourceId={contract.id}
        />

        <AttachmentPanel
          entityType="PurchaseContract"
          entityId={contract.id}
          attachments={attachments}
          canManage={can(user, PERMISSIONS.ATTACHMENTS_MANAGE)}
        />
      </div>
    </div>
  );
}
