import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getLedgerDirectory } from '@/lib/services/ledger-directory';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { LedgerSearch, type LedgerSearchRow } from '@/app/(app)/ledgers/ledger-search';

export const metadata: Metadata = { title: 'General Ledgers' };
export const dynamic = 'force-dynamic';

/**
 * General Ledgers: every account other than a customer or a supplier —
 * cash, banks, agents, loans, capital, income and expense accounts, and any
 * person or company with an account of their own. Type a name and open it.
 *
 * Customers and suppliers keep their own dedicated ledgers. A search that
 * matches one says where its ledger is instead of mixing it into this list.
 */
export default async function LedgersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const entries = await getLedgerDirectory(user.activeCompany.id, user.activeCompany.localCurrency);

  const toRow = (e: (typeof entries)[number]): LedgerSearchRow => ({
    key: e.key,
    name: e.name,
    kind: e.kind,
    detail: e.detail,
    currency: e.currency,
    balanceLabel: formatMoney(e.balance.abs(), e.currency),
    usdLabel: e.usdEquivalent && !e.usdEquivalent.isZero() ? formatMoney(e.usdEquivalent.abs(), 'USD') : null,
    balanceSort: Number(e.balance),
    balanceMeaning: e.balance.isZero() ? 'settled' : e.balanceMeaning,
    href: e.href,
    keywords: e.keywords,
    elsewhere: e.elsewhere,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Ledgers"
        description="Every account that is not a customer or a supplier: cash, banks, agents, loans, capital, income and expenses. Search and open any of them."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'General Ledgers' }]}
        actions={
          <div className="flex flex-wrap gap-2 text-xs">
            <Link href="/ledgers/customers" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">Customer Ledger</Link>
            <Link href="/ledgers/vendors" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">Supplier Ledger</Link>
            <Link href="/reports/journal" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">General Journal</Link>
          </div>
        }
      />
      <LedgerSearch rows={entries.map(toRow)} initialQuery={q ?? ''} />
    </div>
  );
}
