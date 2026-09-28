import type { Metadata } from 'next';
import { DocumentJournal } from '@/components/shared/document-journal';
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { shortDocumentNumber } from '@/lib/short-number';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, SETTLEMENT_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { getInvoiceOutstanding } from '@/lib/services/receipt';
import { DualAmount } from '@/components/shared/dual-amount';
import { formatMoney, formatQuantityKg, formatDate, formatDateTime, formatRate, formatPercent } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { ReportShareButton } from '@/components/share/report-share-button';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { AttachmentPanel } from '@/components/attachments/attachment-panel';
import { loadAttachments } from '@/components/attachments/load';
import { SaleActions } from '@/app/(app)/sales/[id]/sale-actions';
import { invoiceScopeWhere } from '@/lib/auth/scope';
import { RecordHistory } from '@/components/shared/record-history';

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
    where: { id, companyId, ...invoiceScopeWhere(user) },
    include: {
      customer: true,
      shipment: {
        select: {
          id: true,
          jobNumber: true,
          shipmentNumber: true,
          purchaseContract: { select: { contractReference: true } },
        },
      },
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          item: { select: { itemName: true, originCountry: true, grade: true } },
          // Back to the consignment this coffee arrived on, so a sale can be
          // traced to the contract that bought it without leaving the invoice.
          batch: {
            select: {
              batchNumber: true,
              lot: { select: { lotNumber: true } },
              purchaseContract: { select: { contractReference: true, contractNumber: true } },
              shipment: { select: { id: true, jobNumber: true } },
            },
          },
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
              agent: { select: { id: true, agentName: true } },
              cheque: { select: { status: true } },
            },
          },
        },
      },
      creditNotes: {
        where: { status: 'POSTED' },
        select: { id: true, creditNoteNumber: true, creditDate: true, totalAmount: true },
        orderBy: { creditDate: 'asc' },
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

  const livePayments = invoice.allocations
    .filter((a) => a.receipt.status === 'POSTED')
    .sort((a, b) => a.receipt.receiptDate.getTime() - b.receipt.receiptDate.getTime());
  // A cheque that bounced or was cancelled paid nothing; it is listed, not counted.
  const failed = (a: (typeof livePayments)[number]) =>
    a.receipt.cheque?.status === 'BOUNCED' || a.receipt.cheque?.status === 'CANCELLED';
  /*
   * What was actually received: the payments themselves, never "total less
   * outstanding" — that would count a credit note as money in. Credit notes
   * reduce what is owed and are shown as what they are.
   */
  const paidAmount = livePayments.filter((a) => !failed(a)).reduce((t, a) => t.plus(dec(a.amount)), dec(0));
  const creditedAmount = invoice.creditNotes.reduce((t, c) => t.plus(dec(c.totalAmount)), dec(0));
  const attachments = can(user, PERMISSIONS.ATTACHMENTS_VIEW)
    ? await loadAttachments(user.activeCompany.id, 'SalesInvoice', invoice.id)
    : [];
  // Derived from the balance: nothing left is Paid; something received with
  // something left is Partially paid; nothing received is Unpaid.
  const settlement = outstanding
    ? outstanding.amount.lessThanOrEqualTo(0)
      ? 'PAID'
      : paidAmount.greaterThan(0) || creditedAmount.greaterThan(0)
        ? 'PARTIAL'
        : 'UNPAID'
    : 'UNPAID';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${shortDocumentNumber(invoice.invoiceNumber)} — ${invoice.customer.customerName}`}
        description={[formatDate(invoice.invoiceDate), invoice.reference].filter(Boolean).join(' · ')}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Sales', href: '/sales' }, { label: shortDocumentNumber(invoice.invoiceNumber) }]}
        meta={
          <>
            <StatusBadge status={invoice.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone="neutral">{invoice.currency}</Badge>
            {invoice.status === 'POSTED' ? <StatusBadge status={settlement} meta={SETTLEMENT_STATUS_META} /> : null}
            {invoice.shipment ? (
              <Link href={`/shipments/${invoice.shipment.id}`}>
                <Badge tone="info">{invoice.shipment.purchaseContract?.contractReference ?? 'Shipment'}</Badge>
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
            <ReportShareButton report="invoice" subject={`${invoice.customer.customerName} · ${shortDocumentNumber(invoice.invoiceNumber)}`} label="Share invoice" />
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
      <RecordHistory entityType="SalesInvoice" entityId={invoice.id} />

      {invoice.status === 'REVERSED' ? (
        <Callout tone="danger" title="This invoice was deleted">
          {invoice.reversalReason} — deleted {formatDateTime(invoice.reversedAt)}. The stock was returned to the
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
        <Metric
          label="Invoice value"
          value={<DualAmount amount={invoice.totalAmount} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" amountUsd={invoice.currency === user.activeCompany.localCurrency ? invoice.totalAmountUsd : null} />}
        />
        {outstanding ? (
          <>
            <Metric
              label="Paid"
              value={<DualAmount amount={paidAmount} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />}
              tone="positive"
              hint={`${livePayments.filter((a) => !failed(a)).length} ${livePayments.filter((a) => !failed(a)).length === 1 ? 'payment' : 'payments'}`}
            />
            {creditedAmount.greaterThan(0) ? (
              <Metric
                label="Credit notes"
                value={<DualAmount amount={creditedAmount} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />}
                tone="muted"
              />
            ) : null}
            <Metric
              label="Outstanding"
              value={<DualAmount amount={outstanding.amount} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />}
              tone={outstanding.amount.greaterThan(0) ? 'negative' : 'positive'}
            />
          </>
        ) : null}
        {showProfit && invoice.status === 'POSTED' ? (
          <>
            <Metric label="Cost of goods" value={<DualAmount amount={invoice.costOfGoodsUsd} currency="USD" localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />} tone="muted" />
            <Metric
              label="Gross profit"
              value={<DualAmount amount={grossProfitUsd} currency="USD" localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />}
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
                    <TH>Item</TH>
                    <TH>Warehouse</TH>
                    <TH>ICUL/FID Ref</TH>
                    <TH>Lot / Batch</TH>
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
                      <TD className="text-xs">{line.warehouse?.name ?? '—'}</TD>
                      <TD>
                        {line.batch.purchaseContract ? (
                          <Link
                            href={`/trace?ref=${encodeURIComponent(line.batch.purchaseContract.contractReference)}`}
                            className="font-mono text-xs text-forest-800 hover:text-gold-700"
                          >
                            {line.batch.purchaseContract.contractReference}
                          </Link>
                        ) : (
                          <span className="text-xs text-ink-subtle">—</span>
                        )}
                      </TD>
                      <TD>
                        <span className="block">{line.batch.lot.lotNumber}</span>
                        <span className="block text-xs text-ink-subtle">
                          {line.batch.batchNumber}
                          {line.container ? ` · ${line.container.containerNumber}` : ''}
                        </span>
                      </TD>
                      <TD numeric>
                        {formatQuantityKg(line.quantityKg)}
                        <span className="block text-xs text-ink-subtle">{line.bags.toLocaleString()} bags</span>
                      </TD>
                      <TD numeric>
                        <DualAmount amount={line.unitPrice} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" primaryClassName="font-normal" />
                        <span className="block text-xs text-ink-subtle">per {line.unit}</span>
                      </TD>
                      <TD numeric className="font-medium">
                        <DualAmount amount={line.lineTotal} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" />
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
                    <TD numeric>
                      <DualAmount amount={invoice.totalAmount} currency={invoice.currency} localCurrency={user.activeCompany.localCurrency} rateLocalPerUsd={invoice.rateLocalPerUsd} rateSource="This invoice's own rate" amountUsd={invoice.currency === user.activeCompany.localCurrency ? invoice.totalAmountUsd : null} />
                    </TD>
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
                        {formatDate(allocation.receipt.receiptDate)}
                      </span>
                      <span className="block text-xs text-ink-subtle">
                        {shortDocumentNumber(allocation.receipt.receiptNumber, 'PAY')} ·{' '}
                        {PAYMENT_METHOD_LABELS[allocation.receipt.paymentMethod] ?? allocation.receipt.paymentMethod}
                        {allocation.receipt.agent ? ` — ${allocation.receipt.agent.agentName}` : ''}
                        {failed(allocation) ? ` · cheque ${allocation.receipt.cheque?.status.toLowerCase()} — not counted` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-sm font-semibold text-gold-700">
                      {formatMoney(allocation.amount, invoice.currency)}
                    </span>
                  </Link>
                ))
              )}
              {invoice.creditNotes.map((note) => (
                <Link
                  key={note.id}
                  href={`/sales/credit-notes/${note.id}`}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-forest-800">{formatDate(note.creditDate)}</span>
                    <span className="block text-xs text-ink-subtle">
                      {shortDocumentNumber(note.creditNoteNumber, 'CN')} · Credit note — reduces what is owed, not a payment
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-sm font-semibold text-ink-muted">
                    {formatMoney(note.totalAmount, invoice.currency)}
                  </span>
                </Link>
              ))}
              {outstanding ? (
                <dl className="grid grid-cols-2 gap-y-1 border-t border-line pt-3 text-xs" data-testid="invoice-payment-summary">
                  <dt className="text-ink-muted">Invoice total</dt>
                  <dd className="tnum text-right">{formatMoney(invoice.totalAmount, invoice.currency)}</dd>
                  <dt className="text-ink-muted">Total paid</dt>
                  <dd className="tnum text-right">{formatMoney(paidAmount, invoice.currency)}</dd>
                  {creditedAmount.greaterThan(0) ? (
                    <>
                      <dt className="text-ink-muted">Credit notes</dt>
                      <dd className="tnum text-right">{formatMoney(creditedAmount, invoice.currency)}</dd>
                    </>
                  ) : null}
                  <dt className="font-medium text-ink">Outstanding</dt>
                  <dd className="tnum text-right font-semibold">{formatMoney(outstanding.amount, invoice.currency)}</dd>
                  <dt className="text-ink-muted">Status</dt>
                  <dd className="text-right">
                    <StatusBadge status={settlement} meta={SETTLEMENT_STATUS_META} />
                  </dd>
                </dl>
              ) : null}
            </CardContent>
          </Card>

          <DocumentJournal
            localCurrency={user.activeCompany.localCurrency}
            companyId={user.activeCompany.id}
            sourceType="SALES_INVOICE"
            sourceId={invoice.id}
          />

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
