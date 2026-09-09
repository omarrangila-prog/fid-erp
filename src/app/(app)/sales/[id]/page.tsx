import type { Metadata } from 'next';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { getInvoiceOutstanding } from '@/lib/services/receipt';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, formatRate, formatPercent } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { AttachmentPanel } from '@/components/attachments/attachment-panel';
import { loadAttachments } from '@/components/attachments/load';
import { SaleActions } from '@/app/(app)/sales/[id]/sale-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const invoice = await prisma.salesInvoice.findUnique({ where: { id }, select: { invoiceNumber: true } });
  return { title: invoice?.invoiceNumber ?? 'Sales Invoice' };
}

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.SALES_VIEW);
  const companyId = user.activeCompany.id;
  const showProfit = can(user, PERMISSIONS.PROFITS_VIEW);

  const invoice = await prisma.salesInvoice.findFirst({
    where: { id, companyId },
    include: {
      customer: true,
      shipment: { select: { id: true, jobNumber: true, shipmentNumber: true } },
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          item: { select: { itemName: true, originCountry: true, grade: true } },
          batch: { select: { batchNumber: true, lot: { select: { lotNumber: true } } } },
          warehouse: { select: { name: true } },
          container: { select: { containerNumber: true } },
        },
      },
      allocations: {
        include: {
          receipt: {
            select: {
              id: true,
              receiptNumber: true,
              receiptDate: true,
              currency: true,
              amount: true,
              paymentMethod: true,
              status: true,
            },
          },
        },
      },
    },
  });

  if (!invoice) notFound();

  const outstanding =
    invoice.status === 'POSTED' ? await transaction((tx) => getInvoiceOutstanding(tx, invoice.id)) : null;

  const quantityKg = invoice.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0));
  const bags = invoice.lines.reduce((a, l) => a + l.bags, 0);
  const grossProfitUsd = toMoney(dec(invoice.totalAmountUsd).minus(dec(invoice.costOfGoodsUsd)));
  const marginPct = dec(invoice.totalAmountUsd).greaterThan(0)
    ? grossProfitUsd.dividedBy(dec(invoice.totalAmountUsd)).times(100)
    : dec(0);

  const livePayments = invoice.allocations.filter((a) => a.receipt.status === 'POSTED');
  const attachments = can(user, PERMISSIONS.ATTACHMENTS_VIEW)
    ? await loadAttachments(user.activeCompany.id, 'SalesInvoice', invoice.id)
    : [];
  const settlement = outstanding
    ? outstanding.amount.lessThanOrEqualTo(0)
      ? 'PAID'
      : livePayments.length > 0
        ? 'PARTIAL'
        : 'UNPAID'
    : 'UNPAID';

  return (
    <div className="space-y-6">
      <PageHeader
        title={invoice.invoiceNumber}
        description={`${invoice.customer.customerName}${invoice.reference ? ` · ${invoice.reference}` : ''}`}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Sales', href: '/sales' }, { label: invoice.invoiceNumber }]}
        meta={
          <>
            <StatusBadge status={invoice.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone="neutral">{invoice.currency}</Badge>
            {invoice.status === 'POSTED' ? <StatusBadge status={settlement} meta={SETTLEMENT_STATUS_META} /> : null}
            {invoice.shipment ? (
              <Link href={`/shipments/${invoice.shipment.id}`}>
                <Badge tone="info">Job {invoice.shipment.jobNumber}</Badge>
              </Link>
            ) : null}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/sales/${invoice.id}/print`}>
                <Printer />
                Print invoice
              </Link>
            </Button>
            <SaleActions
            id={invoice.id}
            status={invoice.status}
            outstanding={Boolean(outstanding && outstanding.amount.greaterThan(0))}
            canApprove={can(user, PERMISSIONS.SALES_APPROVE)}
            canEdit={can(user, PERMISSIONS.SALES_EDIT)}
            canDelete={can(user, PERMISSIONS.SALES_DELETE)}
            canReverse={can(user, PERMISSIONS.SALES_REVERSE)}
              canReceipt={can(user, PERMISSIONS.RECEIPTS_CREATE)}
            />
          </>
        }
      />

      {invoice.status === 'REVERSED' ? (
        <Callout tone="danger" title="This invoice has been reversed">
          {invoice.reversalReason} — reversed {formatDateTime(invoice.reversedAt)}. The stock was returned to the
          warehouse it came from.
        </Callout>
      ) : null}

      {invoice.status === 'DRAFT' ? (
        <Callout tone="warning" title="Draft — stock is reserved but nothing is posted">
          The quantities below are ring-fenced so nobody else can sell them, but no ledger entry exists yet and the
          customer does not owe anything until this invoice is posted.
        </Callout>
      ) : null}

      <MetricGrid>
        <Metric label="Quantity" value={formatQuantityKg(quantityKg)} hint={`${bags.toLocaleString()} bags`} />
        <Metric label="Invoice value" value={formatMoney(invoice.totalAmount, invoice.currency)} />
        {invoice.currency !== 'USD' ? (
          <Metric label="USD equivalent" value={formatMoney(invoice.totalAmountUsd, 'USD')} tone="muted" />
        ) : null}
        {outstanding ? (
          <>
            <Metric
              label="Received"
              value={formatMoney(dec(invoice.totalAmount).minus(outstanding.amount), invoice.currency)}
              tone="positive"
            />
            <Metric
              label="Outstanding"
              value={formatMoney(outstanding.amount, invoice.currency)}
              tone={outstanding.amount.greaterThan(0) ? 'negative' : 'positive'}
            />
          </>
        ) : null}
        {showProfit && invoice.status === 'POSTED' ? (
          <>
            <Metric label="Cost of goods" value={formatMoney(invoice.costOfGoodsUsd, 'USD')} tone="muted" />
            <Metric
              label="Gross profit"
              value={formatMoney(grossProfitUsd, 'USD')}
              tone={grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
              hint={`${formatPercent(marginPct)} margin`}
            />
          </>
        ) : null}
      </MetricGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Coffee sold</CardTitle>
            <CardDescription>Traceable to the exact lot, batch, container and warehouse.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>#</TH>
                    <TH>Coffee</TH>
                    <TH>Lot / Batch</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Price</TH>
                    <TH numeric>Value</TH>
                    {showProfit ? <TH numeric>Cost</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {invoice.lines.map((line) => (
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
                        <span className="block">{line.batch.lot.lotNumber}</span>
                        <span className="block text-xs text-ink-subtle">
                          {line.batch.batchNumber}
                          {line.container ? ` · ${line.container.containerNumber}` : ''}
                        </span>
                      </TD>
                      <TD className="text-xs">{line.warehouse?.name ?? '—'}</TD>
                      <TD numeric>
                        {formatQuantityKg(line.quantityKg)}
                        <span className="block text-xs text-ink-subtle">{line.bags.toLocaleString()} bags</span>
                      </TD>
                      <TD numeric>
                        {formatMoney(line.unitPrice, invoice.currency)}
                        <span className="block text-xs text-ink-subtle">per {line.unit}</span>
                      </TD>
                      <TD numeric className="font-medium">
                        {formatMoney(line.lineTotal, invoice.currency)}
                      </TD>
                      {showProfit ? <TD numeric>{formatMoney(line.costTotalUsd, 'USD')}</TD> : null}
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={4}>Total</TD>
                    <TD numeric>{formatQuantityKg(quantityKg)}</TD>
                    <TD />
                    <TD numeric>{formatMoney(invoice.totalAmount, invoice.currency)}</TD>
                    {showProfit ? <TD numeric>{formatMoney(invoice.costOfGoodsUsd, 'USD')}</TD> : null}
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Invoice detail</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <DetailRow label="Customer">
                  <Link href={`/customers/${invoice.customerId}`} className="text-gold-700 hover:underline">
                    {invoice.customer.customerName}
                  </Link>
                </DetailRow>
                <DetailRow label="Invoice date">{formatDate(invoice.invoiceDate)}</DetailRow>
                <DetailRow label="Due date">{formatDate(invoice.dueDate)}</DetailRow>
                <DetailRow label="Payment terms">{invoice.paymentTermDays} days</DetailRow>
                <DetailRow label="Reference">{invoice.reference ?? '—'}</DetailRow>
                <DetailRow label="Rate to USD">{formatRate(invoice.rateToUsd)}</DetailRow>
                <DetailRow label={`Rate to ${user.activeCompany.localCurrency}`}>
                  {formatRate(invoice.rateLocalPerUsd)}
                </DetailRow>
                <DetailRow label="Created by">{invoice.createdBy.name}</DetailRow>
                {invoice.postedBy ? (
                  <DetailRow label="Posted by">
                    {invoice.postedBy.name}
                    <span className="block text-xs text-ink-subtle">{formatDateTime(invoice.postedAt)}</span>
                  </DetailRow>
                ) : null}
              </dl>
              {invoice.notes ? (
                <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-xs text-ink-muted">
                  {invoice.notes}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
              <CardDescription>An invoice can be settled in as many instalments as needed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {livePayments.length === 0 ? (
                <p className="py-4 text-center text-xs text-ink-subtle">Nothing received yet.</p>
              ) : (
                livePayments.map((allocation) => (
                  <Link
                    key={allocation.id}
                    href={`/finance/receipts/${allocation.receipt.id}`}
                    className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-forest-800">
                        {allocation.receipt.receiptNumber}
                      </span>
                      <span className="block text-xs text-ink-subtle">
                        {formatDate(allocation.receipt.receiptDate)} ·{' '}
                        {allocation.receipt.paymentMethod.replaceAll('_', ' ').toLowerCase()}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-sm font-semibold text-gold-700">
                      {formatMoney(allocation.amount, invoice.currency)}
                    </span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <AttachmentPanel
            entityType="SalesInvoice"
            entityId={invoice.id}
            attachments={attachments}
            canManage={can(user, PERMISSIONS.ATTACHMENTS_MANAGE)}
          />
        </div>
      </div>
    </div>
  );
}
