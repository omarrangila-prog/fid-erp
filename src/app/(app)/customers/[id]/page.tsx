import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookOpen, Plus } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, SHIPMENT_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { getReceivables } from '@/lib/services/receivables';
import { formatDate, formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent, TabCount } from '@/components/ui/tabs';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { StatCard, DetailRow } from '@/components/shared/stat-card';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id }, select: { customerName: true } });
  return { title: customer?.customerName ?? 'Customer' };
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.CUSTOMERS_VIEW);
  const companyId = user.activeCompany.id;

  const customer = await prisma.customer.findFirst({
    where: { id, companyId },
    include: {
      salesInvoices: {
        orderBy: { invoiceDate: 'desc' },
        include: {
          shipment: { select: { id: true, shipmentNumber: true } },
          lines: { select: { quantityKg: true } },
        },
      },
      receipts: {
        orderBy: { receiptDate: 'desc' },
        include: { cashBankAccount: { select: { name: true } } },
      },
      shipments: {
        orderBy: { createdAt: 'desc' },
        include: { item: { select: { itemName: true } } },
      },
    },
  });

  if (!customer) notFound();

  const receivables = await getReceivables({ companyId, customerId: id, onlyOutstanding: true });
  const outstandingUsd = receivables.reduce((a, r) => a.plus(r.outstandingAmountUsd), dec(0));
  const outstandingOwn = receivables.reduce((a, r) => a.plus(r.outstandingAmount), dec(0));

  const postedInvoices = customer.salesInvoices.filter((i) => i.status === 'POSTED');
  const totalSold = postedInvoices.reduce(
    (a, i) => a.plus(i.lines.reduce((b, l) => b.plus(dec(l.quantityKg)), dec(0))),
    dec(0),
  );
  const totalRevenue = postedInvoices.reduce((a, i) => a.plus(dec(i.totalAmount)), dec(0));
  const overdue = receivables.filter((r) => r.bucket !== 'CURRENT');

  const canSell = can(user, PERMISSIONS.SALES_CREATE);

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.customerName}
        description={[customer.customerCode, customer.country].filter(Boolean).join(' · ')}
        breadcrumbs={[
          { label: 'Masters' },
          { label: 'Customers', href: '/customers' },
          { label: customer.customerName },
        ]}
        meta={
          <>
            <Badge tone="neutral">Ledger in {customer.primaryCurrency}</Badge>
            <Badge tone={customer.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {customer.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </Badge>
            {overdue.length > 0 ? <Badge tone="danger">{overdue.length} overdue</Badge> : null}
          </>
        }
        actions={
          <>
            {can(user, PERMISSIONS.LEDGERS_VIEW) ? (
              <Button variant="outline" asChild>
                <Link href={`/ledgers/customers/${customer.id}`}>
                  <BookOpen />
                  Ledger
                </Link>
              </Button>
            ) : null}
            {canSell ? (
              <Button asChild>
                <Link href={`/sales/new?customer=${customer.id}`}>
                  <Plus />
                  New sale
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={formatMoney(outstandingOwn, customer.primaryCurrency)}
          sublabel={`${formatMoney(outstandingUsd, 'USD')} equivalent`}
          tone={outstandingOwn.greaterThan(0) ? 'warning' : 'default'}
        />
        <StatCard label="Total invoiced" value={formatMoney(totalRevenue, customer.primaryCurrency)} sublabel={`${postedInvoices.length} posted invoices`} />
        <StatCard label="Coffee bought" value={formatQuantityKg(totalSold)} />
        <StatCard
          label="Credit limit"
          value={formatMoney(customer.creditLimit, customer.primaryCurrency)}
          sublabel={`${customer.paymentTermDays} day terms`}
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sales">
            Sales
            <TabCount value={customer.salesInvoices.length} />
          </TabsTrigger>
          <TabsTrigger value="receipts">
            Receipts
            <TabCount value={customer.receipts.length} />
          </TabsTrigger>
          <TabsTrigger value="outstanding">
            Outstanding
            <TabCount value={receivables.length} />
          </TabsTrigger>
          <TabsTrigger value="shipments">
            Shipments
            <TabCount value={customer.shipments.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Contact</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Contact person">{customer.contactPerson ?? '—'}</DetailRow>
                  <DetailRow label="Phone">{customer.phone ?? '—'}</DetailRow>
                  <DetailRow label="WhatsApp">{customer.whatsapp ?? '—'}</DetailRow>
                  <DetailRow label="Email">{customer.email ?? '—'}</DetailRow>
                  <DetailRow label="Address">{customer.address ?? '—'}</DetailRow>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Trading terms</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Ledger currency">{customer.primaryCurrency}</DetailRow>
                  <DetailRow label="Payment terms">{customer.paymentTermDays} days</DetailRow>
                  <DetailRow label="Credit limit">
                    {formatMoney(customer.creditLimit, customer.primaryCurrency)}
                  </DetailRow>
                  <DetailRow label="Opening balance">
                    {formatMoney(customer.openingBalance, customer.primaryCurrency)}
                  </DetailRow>
                  <DetailRow label="Customer since">{formatDate(customer.createdAt)}</DetailRow>
                </dl>
                {customer.notes ? (
                  <p className="mt-4 rounded-lg bg-forest-50 p-3 text-xs leading-relaxed text-ink-muted">
                    {customer.notes}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="sales">
          {customer.salesInvoices.length === 0 ? (
            <EmptyState title="No sales yet" description="Invoices raised for this customer will appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Invoice</TH>
                    <TH>Date</TH>
                    <TH>Due</TH>
                    <TH>Shipment</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Amount</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {customer.salesInvoices.map((invoice) => (
                    <TR key={invoice.id}>
                      <TD>
                        <Link href={`/sales/${invoice.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {invoice.invoiceNumber}
                        </Link>
                      </TD>
                      <TD>{formatDate(invoice.invoiceDate)}</TD>
                      <TD>{formatDate(invoice.dueDate)}</TD>
                      <TD>
                        {invoice.shipment ? (
                          <Link href={`/shipments/${invoice.shipment.id}`} className="text-forest-800 hover:text-gold-700">
                            {invoice.shipment.shipmentNumber}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD numeric>
                        {formatQuantityKg(invoice.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0)))}
                      </TD>
                      <TD numeric>{formatMoney(invoice.totalAmount, invoice.currency)}</TD>
                      <TD>
                        <StatusBadge status={invoice.status} meta={TRANSACTION_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="receipts">
          {customer.receipts.length === 0 ? (
            <EmptyState title="No receipts yet" description="Payments received from this customer will appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Receipt</TH>
                    <TH>Date</TH>
                    <TH>Method</TH>
                    <TH>Account</TH>
                    <TH numeric>Amount</TH>
                    <TH numeric>Rate</TH>
                    <TH numeric>USD</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {customer.receipts.map((receipt) => (
                    <TR key={receipt.id}>
                      <TD>
                        <Link
                          href={`/finance/receipts/${receipt.id}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {receipt.receiptNumber}
                        </Link>
                      </TD>
                      <TD>{formatDate(receipt.receiptDate)}</TD>
                      <TD>{PAYMENT_METHOD_LABELS[receipt.paymentMethod] ?? receipt.paymentMethod}</TD>
                      <TD>{receipt.cashBankAccount?.name ?? 'Cheque in hand'}</TD>
                      <TD numeric>{formatMoney(receipt.amount, receipt.currency)}</TD>
                      <TD numeric>{receipt.currency === 'USD' ? '—' : receipt.rateToUsd.toString()}</TD>
                      <TD numeric>{formatMoney(receipt.amountUsd, 'USD')}</TD>
                      <TD>
                        <StatusBadge status={receipt.status} meta={TRANSACTION_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="outstanding">
          {receivables.length === 0 ? (
            <EmptyState title="Nothing outstanding" description="This customer has settled every posted invoice." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Invoice</TH>
                    <TH>Due</TH>
                    <TH numeric>Invoiced</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Outstanding</TH>
                    <TH>Ageing</TH>
                  </TR>
                </THead>
                <TBody>
                  {receivables.map((row) => (
                    <TR key={row.invoiceId}>
                      <TD>
                        <Link href={`/sales/${row.invoiceId}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {row.invoiceNumber}
                        </Link>
                      </TD>
                      <TD>{formatDate(row.dueDate)}</TD>
                      <TD numeric>{formatMoney(row.originalAmount, row.currency)}</TD>
                      <TD numeric>{formatMoney(row.paidAmount, row.currency)}</TD>
                      <TD numeric className="font-semibold">
                        {formatMoney(row.outstandingAmount, row.currency)}
                      </TD>
                      <TD>
                        <Badge tone={row.bucket === 'CURRENT' ? 'success' : row.bucket === 'D90_PLUS' ? 'danger' : 'warning'}>
                          {row.bucket === 'CURRENT' ? 'Current' : row.bucket.replace('D', '').replace('_', '–') + ' days'}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="shipments">
          {customer.shipments.length === 0 ? (
            <EmptyState title="No shipments assigned" description="Shipments allocated to this customer appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Shipment</TH>
                    <TH>Job</TH>
                    <TH>Coffee</TH>
                    <TH numeric>Quantity</TH>
                    <TH>ETA</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {customer.shipments.map((shipment) => (
                    <TR key={shipment.id}>
                      <TD>
                        <Link href={`/shipments/${shipment.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {shipment.shipmentNumber}
                        </Link>
                      </TD>
                      <TD>{shipment.jobNumber}</TD>
                      <TD>{shipment.item.itemName}</TD>
                      <TD numeric>{formatQuantityKg(shipment.quantityKg)}</TD>
                      <TD>{formatDate(shipment.etaDate)}</TD>
                      <TD>
                        <StatusBadge status={shipment.status} meta={SHIPMENT_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
