import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookText, Plus } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, SHIPMENT_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { getPayables } from '@/lib/services/receivables';
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
  const vendor = await prisma.vendor.findUnique({ where: { id }, select: { vendorName: true } });
  return { title: vendor?.vendorName ?? 'Supplier' };
}

export default async function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.VENDORS_VIEW);
  const companyId = user.activeCompany.id;
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const vendor = await prisma.vendor.findFirst({
    where: { id, companyId },
    include: {
      purchaseContracts: {
        orderBy: { contractDate: 'desc' },
        include: {
          lines: { select: { quantityKg: true, item: { select: { itemName: true } } } },
          shipments: { select: { id: true, shipmentNumber: true, jobNumber: true } },
        },
      },
      payments: { orderBy: { paymentDate: 'desc' }, include: { cashBankAccount: { select: { name: true } } } },
      shipments: { orderBy: { createdAt: 'desc' }, include: { item: { select: { itemName: true } } } },
    },
  });

  if (!vendor) notFound();

  const payables = await getPayables({ companyId, vendorId: id, onlyOutstanding: true });
  const outstandingUsd = payables.reduce((a, p) => a.plus(p.outstandingAmountUsd), dec(0));

  const posted = vendor.purchaseContracts.filter((c) => c.status === 'POSTED');
  const totalBoughtKg = posted.reduce(
    (a, c) => a.plus(c.lines.reduce((b, l) => b.plus(dec(l.quantityKg)), dec(0))),
    dec(0),
  );
  const totalValueUsd = posted.reduce((a, c) => a.plus(dec(c.totalValueUsd)), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title={vendor.vendorName}
        description={[vendor.vendorCode, vendor.country].filter(Boolean).join(' · ')}
        breadcrumbs={[{ label: 'Masters' }, { label: 'Suppliers', href: '/vendors' }, { label: vendor.vendorName }]}
        meta={
          <>
            <Badge tone="neutral">Ledger in {vendor.primaryCurrency}</Badge>
            <Badge tone={vendor.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {vendor.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </Badge>
          </>
        }
        actions={
          <>
            {can(user, PERMISSIONS.LEDGERS_VIEW) ? (
              <Button variant="outline" asChild>
                <Link href={`/ledgers/vendors/${vendor.id}`}>
                  <BookText />
                  Ledger
                </Link>
              </Button>
            ) : null}
            {can(user, PERMISSIONS.PURCHASES_CREATE) ? (
              <Button asChild>
                <Link href="/purchases/new">
                  <Plus />
                  New contract
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="We owe"
          value={formatMoney(outstandingUsd, 'USD')}
          sublabel={`${payables.length} open contract${payables.length === 1 ? '' : 's'}`}
          tone={outstandingUsd.greaterThan(0) ? 'warning' : 'default'}
        />
        <StatCard label="Contracts" value={String(vendor.purchaseContracts.length)} sublabel={`${posted.length} approved`} />
        <StatCard label="Coffee bought" value={formatQuantityKg(totalBoughtKg)} />
        {showCost ? (
          <StatCard label="Total purchased" value={formatMoney(totalValueUsd, 'USD')} sublabel={`${vendor.paymentTermDays} day terms`} />
        ) : (
          <StatCard label="Payment terms" value={`${vendor.paymentTermDays} days`} />
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="purchases">
            Purchases
            <TabCount value={vendor.purchaseContracts.length} />
          </TabsTrigger>
          <TabsTrigger value="payments">
            Payments
            <TabCount value={vendor.payments.length} />
          </TabsTrigger>
          <TabsTrigger value="outstanding">
            Outstanding
            <TabCount value={payables.length} />
          </TabsTrigger>
          <TabsTrigger value="shipments">
            Shipments
            <TabCount value={vendor.shipments.length} />
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
                  <DetailRow label="Contact person">{vendor.contactPerson ?? '—'}</DetailRow>
                  <DetailRow label="Phone">{vendor.phone ?? '—'}</DetailRow>
                  <DetailRow label="WhatsApp">{vendor.whatsapp ?? '—'}</DetailRow>
                  <DetailRow label="Email">{vendor.email ?? '—'}</DetailRow>
                  <DetailRow label="Address">{vendor.address ?? '—'}</DetailRow>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Settlement</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Ledger currency">{vendor.primaryCurrency}</DetailRow>
                  <DetailRow label="Payment terms">{vendor.paymentTermDays} days</DetailRow>
                  <DetailRow label="Opening balance">
                    {formatMoney(vendor.openingBalance, vendor.primaryCurrency)}
                  </DetailRow>
                  <DetailRow label="Supplier since">{formatDate(vendor.createdAt)}</DetailRow>
                </dl>
                {vendor.bankDetails ? (
                  <div className="mt-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Bank details</p>
                    <p className="whitespace-pre-line rounded-lg bg-forest-50 p-3 text-xs leading-relaxed text-ink-muted">
                      {vendor.bankDetails}
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="purchases">
          {vendor.purchaseContracts.length === 0 ? (
            <EmptyState title="No contracts yet" description="Purchase contracts with this supplier appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Contract</TH>
                    <TH>Date</TH>
                    <TH>Coffee</TH>
                    <TH>Job</TH>
                    <TH numeric>Quantity</TH>
                    {showCost ? <TH numeric>Value</TH> : null}
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {vendor.purchaseContracts.map((contract) => (
                    <TR key={contract.id}>
                      <TD>
                        <Link href={`/purchases/${contract.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {contract.contractNumber}
                        </Link>
                        <span className="block text-xs text-ink-subtle">{contract.contractReference}</span>
                      </TD>
                      <TD>{formatDate(contract.contractDate)}</TD>
                      <TD>{[...new Set(contract.lines.map((l) => l.item.itemName))].join(', ') || '—'}</TD>
                      <TD>{contract.shipments[0]?.jobNumber ?? '—'}</TD>
                      <TD numeric>
                        {formatQuantityKg(contract.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0)))}
                      </TD>
                      {showCost ? <TD numeric>{formatMoney(contract.totalValue, contract.currency)}</TD> : null}
                      <TD>
                        <StatusBadge status={contract.status} meta={TRANSACTION_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="payments">
          {vendor.payments.length === 0 ? (
            <EmptyState title="No payments yet" description="Payments made to this supplier appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Payment</TH>
                    <TH>Date</TH>
                    <TH>Method</TH>
                    <TH>Account</TH>
                    <TH numeric>Amount</TH>
                    <TH numeric>USD</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {vendor.payments.map((payment) => (
                    <TR key={payment.id}>
                      <TD>
                        <Link
                          href={`/finance/payments/${payment.id}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {payment.paymentNumber}
                        </Link>
                      </TD>
                      <TD>{formatDate(payment.paymentDate)}</TD>
                      <TD>{PAYMENT_METHOD_LABELS[payment.paymentMethod] ?? payment.paymentMethod}</TD>
                      <TD>{payment.cashBankAccount?.name ?? 'Cheque issued'}</TD>
                      <TD numeric>{formatMoney(payment.amount, payment.currency)}</TD>
                      <TD numeric>{formatMoney(payment.amountUsd, 'USD')}</TD>
                      <TD>
                        <StatusBadge status={payment.status} meta={TRANSACTION_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="outstanding">
          {payables.length === 0 ? (
            <EmptyState title="Nothing outstanding" description="Every approved contract with this supplier is settled." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Contract</TH>
                    <TH>Due</TH>
                    <TH numeric>Contract value</TH>
                    <TH numeric>Paid</TH>
                    <TH numeric>Outstanding</TH>
                  </TR>
                </THead>
                <TBody>
                  {payables.map((row) => (
                    <TR key={row.contractId}>
                      <TD>
                        <Link href={`/purchases/${row.contractId}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {row.contractNumber}
                        </Link>
                      </TD>
                      <TD>{formatDate(row.dueDate)}</TD>
                      <TD numeric>{formatMoney(row.purchaseValue, row.currency)}</TD>
                      <TD numeric>{formatMoney(row.paidAmount, row.currency)}</TD>
                      <TD numeric className="font-semibold">
                        {formatMoney(row.outstandingAmount, row.currency)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="shipments">
          {vendor.shipments.length === 0 ? (
            <EmptyState title="No shipments yet" description="Jobs sourced from this supplier appear here." />
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
                  {vendor.shipments.map((shipment) => (
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
