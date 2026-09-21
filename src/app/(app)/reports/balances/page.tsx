import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatDate, formatMoney } from '@/lib/format';
import { Decimal } from '@/lib/money';
import { getCustomerBalances, getVendorBalances } from '@/lib/services/reports';
import { PageHeader } from '@/components/shared/page-header';
import { ExportLinks } from '@/components/shared/export-links';
import { exportHref } from '@/components/shared/excel-link';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { StatementHeader, FavouriteStar } from '@/components/reports/report-statement';

export const metadata: Metadata = { title: 'Balance Summary' };
export const dynamic = 'force-dynamic';

/**
 * Customer balance summary, and supplier balance summary: one line per
 * party per currency, the balance, a total per currency. Click a name for
 * the ledger. The simplest report there is, and one of the most read.
 */
export default async function BalancesPage({ searchParams }: { searchParams: Promise<{ side?: string }> }) {
  const { side } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const suppliers = side === 'suppliers';
  const rows = suppliers ? await getVendorBalances(user.activeCompany.id) : await getCustomerBalances(user.activeCompany.id);
  const title = suppliers ? 'Supplier Balance Summary' : 'Customer Balance Summary';
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const totalUsd = rows.reduce((a, r) => a.plus(r.balanceUsd), new Decimal(0));

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={suppliers ? 'What the company owes each supplier, right now.' : 'What each customer owes, right now.'}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: title }]}
        actions={
          <>
            <FavouriteStar href={suppliers ? '/reports/balances?side=suppliers' : '/reports/balances'} label={title} />
            <ExportLinks href={exportHref('balances', suppliers ? { side: 'suppliers' } : {})} print={false} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title={title} companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="flex gap-2 print:hidden">
        <Link href="/reports/balances" className={`rounded-md px-3 py-1.5 text-sm ${!suppliers ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}>
          Customers
        </Link>
        <Link href="/reports/balances?side=suppliers" className={`rounded-md px-3 py-1.5 text-sm ${suppliers ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}>
          Suppliers
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing outstanding" description={suppliers ? 'Every supplier is settled.' : 'Every customer is settled.'} />
      ) : (
        <Card>
          <CardContent className="px-2 pb-4 pt-2 sm:px-4">
            <StatementHeader
              company={user.activeCompany.name}
              title={title}
              period={`As at ${formatDate(new Date())}`}
              meta={<p className="text-xs text-ink-subtle">{formatMoney(totalUsd, 'USD')} in total at USD value</p>}
            />
            <table className="w-full max-w-2xl border-collapse text-sm">
              <thead>
                <tr className="border-b border-line-strong text-[11px] uppercase tracking-wider text-ink-muted">
                  <th className="px-3 py-2 text-left font-semibold">{suppliers ? 'Supplier' : 'Customer'}</th>
                  <th className="px-3 py-2 text-right font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.partyId}:${row.currency}`} className="border-t border-line hover:bg-surface-sunken/40">
                    <td className="px-3 py-2">
                      <Link href={row.href} className="font-medium text-ink hover:text-gold-700 hover:underline">
                        {row.partyName}
                      </Link>
                    </td>
                    <td className="tnum px-3 py-2 text-right">{formatMoney(row.balance, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {currencies.map((currency) => (
                  <tr key={currency} className="border-t-2 border-line-strong bg-surface-sunken/40 font-semibold">
                    <td className="px-3 py-2">Total {currency}</td>
                    <td className="tnum px-3 py-2 text-right">
                      {formatMoney(rows.filter((r) => r.currency === currency).reduce((a, r) => a.plus(r.balance), new Decimal(0)), currency)}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
