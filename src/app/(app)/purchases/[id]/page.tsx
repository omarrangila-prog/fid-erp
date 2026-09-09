import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, INCOTERM_LABELS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec } from '@/lib/money';
import { getReceiptStatus } from '@/lib/services/purchase';
import { getContractOutstanding } from '@/lib/services/payment';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { PurchaseDetailToolbar } from '@/app/(app)/purchases/[id]/detail-toolbar';

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

  const [receiptStatus, outstanding, warehouses] = await Promise.all([
    transaction((tx) => getReceiptStatus(tx, contract.id)),
    contract.status === 'POSTED'
      ? transaction((tx) => getContractOutstanding(tx, contract.id))
      : Promise.resolve(null),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, isDefault: true },
    }),
  ]);

  const totalOrdered = receiptStatus.reduce((a, r) => a.plus(r.orderedKg), dec(0));
  const totalReceived = receiptStatus.reduce((a, r) => a.plus(r.receivedKg), dec(0));
  const fullyReceived = totalOrdered.greaterThan(0) && totalReceived.greaterThanOrEqualTo(totalOrdered);
  const job = contract.shipments[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={contract.contractNumber}
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
            {job ? (
              <Link href={`/shipments/${job.id}`}>
                <Badge tone="info">Job {job.jobNumber}</Badge>
              </Link>
            ) : null}
          </>
        }
        actions={
          <PurchaseDetailToolbar
            id={contract.id}
            contractNumber={contract.contractNumber}
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
              itemName: r.itemName,
              lotNumber: r.lotNumber,
              containerNumber: r.containerNumber,
              orderedKg: r.orderedKg.toString(),
              receivedKg: r.receivedKg.toString(),
              outstandingKg: r.outstandingKg.toString(),
              bagWeightKg: r.bagWeightKg.toString(),
            }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))}
            defaultWarehouseId={warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? null}
          />
        }
      />

      {contract.status === 'REVERSED' ? (
        <Callout tone="danger" title="This contract has been reversed">
          {contract.reversalReason} — reversed {formatDateTime(contract.reversedAt)}.
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
            <CardTitle>Coffee lines</CardTitle>
            <CardDescription>Each line is a lot and batch you can receive and sell separately.</CardDescription>
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
                      <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                      <TD numeric>{line.bags.toLocaleString()}</TD>
                      {showCost ? (
                        <>
                          <TD numeric>
                            {formatMoney(line.unitPrice, contract.currency)}
                            <span className="block text-xs text-ink-subtle">per {line.unit}</span>
                          </TD>
                          <TD numeric>{formatMoney(line.lineSubtotal, contract.currency)}</TD>
                          <TD numeric className="font-medium text-teal-700">
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
                  <Link href={`/vendors/${contract.vendorId}`} className="text-teal-700 hover:underline">
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
                <DetailRow label="Payment terms">{contract.paymentTermDays} days</DetailRow>
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

          {job ? (
            <Card>
              <CardHeader>
                <CardTitle>Job</CardTitle>
                <CardDescription>Costs and sales roll up to this job.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Job number">
                    <Link href={`/shipments/${job.id}`} className="text-teal-700 hover:underline">
                      {job.jobNumber}
                    </Link>
                  </DetailRow>
                  <DetailRow label="Shipment">{job.shipmentNumber}</DetailRow>
                  <DetailRow label="Status">
                    <StatusBadge status={job.status} meta={SHIPMENT_STATUS_META} />
                  </DetailRow>
                  <DetailRow label="ETA">{formatDate(job.etaDate)}</DetailRow>
                </dl>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {contract.status === 'POSTED' ? (
        <Card>
          <CardHeader>
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
                      <TD numeric>{formatQuantityKg(r.orderedKg)}</TD>
                      <TD numeric>{formatQuantityKg(r.receivedKg)}</TD>
                      <TD numeric className={r.outstandingKg.greaterThan(0) ? 'font-medium text-amber-700' : 'text-teal-700'}>
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
                      <span className="font-medium text-ink">{grn.grnNumber}</span>
                      <span className="ml-2 text-xs text-ink-subtle">
                        {formatDate(grn.receiptDate)} · {grn.warehouse.name}
                      </span>
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
    </div>
  );
}
