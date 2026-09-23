import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HandCoins } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getVendorLedger, ledgerKindToSourceType, resolvePartyLedgerQuery } from '@/lib/services/ledger';
import { getPayables } from '@/lib/services/receivables';
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
  const vendor = await prisma.vendor.findUnique({ where: { id }, select: { vendorName: true } });
  return { title: vendor ? `${vendor.vendorName} · Ledger` : 'Supplier Ledger' };
}

export default async function VendorLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; from?: string; to?: string; kind?: string; currency?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const vendor = await prisma.vendor.findFirst({ where: { id, companyId } });
  if (!vendor) notFound();

  const resolved = resolvePartyLedgerQuery({
    view: query.view,
    currency: query.currency,
    localCurrency: user.activeCompany.localCurrency,
    partyCurrency: vendor.primaryCurrency,
  });
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined;

  const [ledger, payables] = await Promise.all([
    getVendorLedger({
      companyId,
      vendorId: id,
      view: resolved.view,
      currency: resolved.currency,
      localCurrency: user.activeCompany.localCurrency,
      partyCurrency: vendor.primaryCurrency,
      from,
      to,
      sourceType: ledgerKindToSourceType(query.kind, 'vendor'),
    }),
    getPayables({ companyId, vendorId: id, onlyOutstanding: true }),
  ]);

  const outstanding = payables.reduce(
    (a, p) => a.plus(p.outstandingAmount),
    ledger.openingBalance.minus(ledger.openingBalance),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={vendor.vendorName}
        description={vendor.country ?? undefined}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Supplier Ledgers', href: '/ledgers/vendors' },
          { label: vendor.vendorName },
        ]}
        meta={
          <>
            <Badge tone="neutral">Viewing {ledger.viewCurrency}</Badge>
            <Badge tone={vendor.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {vendor.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </Badge>
          </>
        }
        actions={
          can(user, PERMISSIONS.PAYMENTS_CREATE) ? (
            <Button asChild>
              <Link href="/finance/payments/new">
                <HandCoins />
                Record payment
              </Link>
            </Button>
          ) : undefined
        }
      />

      <MetricGrid className="lg:grid-cols-3" data-print-drop>
        <Metric
          label="Balance"
          value={formatMoney(ledger.closingBalance, ledger.viewCurrency)}
          tone={ledger.closingBalance.greaterThan(0) ? 'negative' : 'default'}
          hint="Positive means we owe the supplier"
        />
        <Metric label="Open contracts" value={String(payables.length)} />
        <Metric label="Outstanding" value={formatMoney(outstanding, vendor.primaryCurrency)} />
      </MetricGrid>

      <LedgerToolbar
        basePath={`/ledgers/vendors/${id}`}
        printPath={`/ledgers/vendors/${id}/print`}
        exportReport="vendor-ledger"
        vendorId={id}
        view={resolved.view}
        currency={resolved.currency ?? ''}
        from={query.from ?? ''}
        to={query.to ?? ''}
        kind={query.kind ?? 'ALL'}
      />

      <Callout tone="info">
        The USD and MAD tabs each show only that currency’s vouchers and balance. They are never added together.
      </Callout>

      <LedgerView
        ledger={ledger}
        basePath={`/ledgers/vendors/${id}`}
        extraQuery={{ from: query.from, to: query.to, kind: query.kind, currency: resolved.currency }}
        partyCurrency={vendor.primaryCurrency}
        localCurrency={user.activeCompany.localCurrency}
        emptyDescription="Approve a purchase contract or post a payment to open this supplier's ledger."
        canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
      />
    </div>
  );
}
