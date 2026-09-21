import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getLedgerDirectory } from '@/lib/services/ledger-directory';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { LedgerSearch, type LedgerSearchRow } from '@/app/(app)/ledgers/ledger-search';

export const metadata: Metadata = { title: 'Ledgers' };
export const dynamic = 'force-dynamic';

/**
 * Every ledger in one place. Type a name — Ideal Commodities, a bank, a loan,
 * an agent — and open its ledger, without first deciding whether it is a
 * customer, a supplier or an account.
 */
export default async function LedgersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const entries = await getLedgerDirectory(user.activeCompany.id, user.activeCompany.localCurrency);

  const rows: LedgerSearchRow[] = entries.map((e) => ({
    key: e.key,
    name: e.name,
    kind: e.kind,
    detail: e.detail,
    currency: e.currency,
    balanceLabel: formatMoney(e.balance.abs(), e.currency),
    balanceSort: Number(e.balance),
    balanceMeaning: e.balance.isZero() ? 'settled' : e.balanceMeaning,
    href: e.href,
    keywords: e.keywords,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledgers"
        description="Search any customer, supplier, agent, bank, cash, loan or account, and open its ledger."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Ledgers' }]}
        actions={
          <div className="flex flex-wrap gap-2 text-xs">
            <Link href="/ledgers/customers" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">All customers</Link>
            <Link href="/ledgers/vendors" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">All suppliers</Link>
            <Link href="/ledgers/agents" className="rounded-md border border-line px-2.5 py-1.5 text-ink-muted hover:text-ink">All agents</Link>
          </div>
        }
      />
      <LedgerSearch rows={rows} initialQuery={q ?? ''} />
    </div>
  );
}
