import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HandCoins } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getVendorLedger, type LedgerView as LedgerViewMode } from '@/lib/services/ledger';
import { getPayables } from '@/lib/services/receivables';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LedgerView } from '@/components/shared/ledger-view';

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
  searchParams: Promise<{ view?: string }>;
}) {
  const [{ id }, { view }] = await Promise.all([params, searchParams]);
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const vendor = await prisma.vendor.findFirst({ where: { id, companyId } });
  if (!vendor) notFound();

  const mode: LedgerViewMode = view === 'USD' || view === 'LOCAL' || view === 'TRANSACTION' ? view : 'TRANSACTION';

  const [ledger, payables] = await Promise.all([
    getVendorLedger({
      companyId,
      vendorId: id,
      view: mode,
      localCurrency: user.activeCompany.localCurrency,
      partyCurrency: vendor.primaryCurrency,
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
        description={`${vendor.vendorCode}${vendor.country ? ` · ${vendor.country}` : ''}`}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Supplier Ledgers', href: '/ledgers/vendors' },
          { label: vendor.vendorName },
        ]}
        meta={
          <>
            <Badge tone="neutral">Ledger in {vendor.primaryCurrency}</Badge>
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

      <MetricGrid className="lg:grid-cols-3">
        <Metric
          label="Balance"
          value={formatMoney(ledger.closingBalance, ledger.viewCurrency)}
          tone={ledger.closingBalance.greaterThan(0) ? 'negative' : 'default'}
          hint="Positive means we owe the supplier"
        />
        <Metric label="Open contracts" value={String(payables.length)} />
        <Metric label="Outstanding" value={formatMoney(outstanding, vendor.primaryCurrency)} />
      </MetricGrid>

      <LedgerView
        ledger={ledger}
        basePath={`/ledgers/vendors/${id}`}
        partyCurrency={vendor.primaryCurrency}
        localCurrency={user.activeCompany.localCurrency}
        emptyDescription="Approve a purchase contract or post a payment to open this supplier's ledger."
      />
    </div>
  );
}
