import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getCustomerLedger, ledgerKindToSourceType, resolvePartyLedgerQuery } from '@/lib/services/ledger';
import { getReceivables } from '@/lib/services/receivables';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LedgerView } from '@/components/shared/ledger-view';
import { LedgerToolbar } from '@/app/(app)/ledgers/ledger-toolbar';
import { Callout } from '@/components/ui/feedback';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id }, select: { customerName: true } });
  return { title: customer ? `${customer.customerName} · Ledger` : 'Customer Ledger' };
}

export default async function CustomerLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; from?: string; to?: string; kind?: string; currency?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const customer = await prisma.customer.findFirst({ where: { id, companyId } });
  if (!customer) notFound();

  const resolved = resolvePartyLedgerQuery({
    view: query.view,
    currency: query.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: customer.primaryCurrency,
  });
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined;

  const [ledger, receivables] = await Promise.all([
    getCustomerLedger({
      companyId,
      customerId: id,
      view: resolved.view,
      currency: resolved.currency,
      localCurrency: user.activeCompany.localCurrency,
      partyCurrency: customer.primaryCurrency,
      from,
      to,
      sourceType: ledgerKindToSourceType(query.kind),
    }),
    getReceivables({ companyId, customerId: id, onlyOutstanding: true }),
  ]);

  const outstanding = receivables.reduce((a, r) => a.plus(r.outstandingAmount), ledger.openingBalance.minus(ledger.openingBalance));
  const overdue = receivables
    .filter((r) => r.bucket !== 'CURRENT')
    .reduce((a, r) => a.plus(r.outstandingAmount), outstanding.minus(outstanding));

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.customerName}
        description={customer.country ?? undefined}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Customer Ledgers', href: '/ledgers/customers' },
          { label: customer.customerName },
        ]}
        meta={
          <>
            <Badge tone="neutral">Viewing {ledger.viewCurrency}</Badge>
            <Badge tone={customer.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {customer.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </Badge>
          </>
        }
        actions={
          can(user, PERMISSIONS.RECEIPTS_CREATE) ? (
            <Button asChild>
              <Link href="/finance/receipts/new">
                <Banknote />
                Record receipt
              </Link>
            </Button>
          ) : undefined
        }
      />

      <MetricGrid className="lg:grid-cols-4" data-print-drop>
        <Metric
          label="Balance"
          value={formatMoney(ledger.closingBalance, ledger.viewCurrency)}
          tone={ledger.closingBalance.greaterThan(0) ? 'negative' : 'default'}
          hint="Positive means the customer owes us"
        />
        <Metric label="Outstanding invoices" value={formatMoney(outstanding, customer.primaryCurrency)} />
        <Metric
          label="Overdue"
          value={formatMoney(overdue, customer.primaryCurrency)}
          tone={overdue.greaterThan(0) ? 'negative' : 'positive'}
        />
        <Metric label="Credit limit" value={formatMoney(customer.creditLimit, customer.primaryCurrency)} tone="muted" />
      </MetricGrid>

      <LedgerToolbar
        basePath={`/ledgers/customers/${id}`}
        printPath={`/ledgers/customers/${id}/print`}
        exportReport="customer-ledger"
        customerId={id}
        view={resolved.view}
        currency={resolved.currency ?? ''}
        from={query.from ?? ''}
        to={query.to ?? ''}
        kind={query.kind ?? 'ALL'}
      />

      <Callout tone="info">
        The USD and MAD tabs each show only that currency’s vouchers and balance. They are never added together.
        Export follows the currency currently selected.
      </Callout>

      <LedgerView
        ledger={ledger}
        basePath={`/ledgers/customers/${id}`}
        extraQuery={{ from: query.from, to: query.to, kind: query.kind, currency: resolved.currency }}
        partyCurrency={customer.primaryCurrency}
        localCurrency={user.activeCompany.localCurrency}
        emptyDescription="Post a sales invoice or a receipt to open this customer's ledger."
        canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
      />
    </div>
  );
}
