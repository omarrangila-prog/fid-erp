import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatDate, formatMoney } from '@/lib/format';
import { Decimal } from '@/lib/money';
import {
  AGEING_BUCKETS,
  AGEING_LABELS,
  getPayablesAgeing,
  getReceivablesAgeing,
  type AgeingSummaryRow,
} from '@/lib/services/receivables';
import { PageHeader } from '@/components/shared/page-header';
import { ExportLinks } from '@/components/shared/export-links';
import { exportHref } from '@/components/shared/excel-link';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { StatementHeader, FavouriteStar } from '@/components/reports/report-statement';
import { AgeingTable } from '@/app/(app)/reports/ageing/ageing-table';

export const metadata: Metadata = { title: 'Ageing' };
export const dynamic = 'force-dynamic';

/**
 * Accounts receivable and accounts payable ageing, summary and detail in one
 * report: a row per party, a column per bucket, and each row opens into the
 * documents behind it. `?side=payables` turns it round for the suppliers.
 */
export default async function AgeingPage({ searchParams }: { searchParams: Promise<{ side?: string }> }) {
  const { side } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const payables = side === 'payables';
  const rows = payables ? await getPayablesAgeing(user.activeCompany.id) : await getReceivablesAgeing(user.activeCompany.id);

  const bucketLabels = AGEING_BUCKETS.map((b) => AGEING_LABELS[b]);
  const money = (value: Decimal, currency: string) => (value.isZero() ? '—' : formatMoney(value, currency));

  // Totals per currency; a dirham column and a dollar column are never summed.
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const totals = currencies.map((currency) => {
    const inCurrency = rows.filter((r) => r.currency === currency);
    const sumOf = (pick: (r: AgeingSummaryRow) => Decimal) => inCurrency.reduce((a, r) => a.plus(pick(r)), new Decimal(0));
    return {
      currency,
      buckets: AGEING_BUCKETS.map((b) => money(sumOf((r) => r.byBucket[b]), currency)),
      total: formatMoney(sumOf((r) => r.total), currency),
    };
  });
  const totalUsd = rows.reduce((a, r) => a.plus(r.totalUsd), new Decimal(0));

  const title = payables ? 'Accounts Payable Ageing' : 'Accounts Receivable Ageing';
  const href = payables ? '/reports/ageing?side=payables' : '/reports/ageing';

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={
          payables
            ? 'What the company owes each supplier, by how long it has been owed. Open a row for the bills behind it.'
            : 'What each customer owes, by how long it has been owed. Open a row for the invoices behind it.'
        }
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: title }]}
        actions={
          <>
            <FavouriteStar href={href} label={title} />
            <ExportLinks href={exportHref('ageing', payables ? { side: 'payables' } : {})} print={false} />
            <ExportLinks href={exportHref('ageing-detail', payables ? { side: 'payables' } : {})} print={false} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title={title} companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="flex gap-2 print:hidden">
        <a
          href="/reports/ageing"
          className={`rounded-md px-3 py-1.5 text-sm ${!payables ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}
        >
          Customers owe us
        </a>
        <a
          href="/reports/ageing?side=payables"
          className={`rounded-md px-3 py-1.5 text-sm ${payables ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}
        >
          We owe suppliers
        </a>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={payables ? 'Nothing owed to suppliers' : 'Nothing outstanding'}
          description={payables ? 'Every supplier bill is settled.' : 'Every customer invoice is paid.'}
        />
      ) : (
        <Card>
          <CardContent className="px-2 pb-4 pt-2 sm:px-4">
            <StatementHeader
              company={user.activeCompany.name}
              title={title}
              period={`As at ${formatDate(new Date())}`}
              meta={<p className="text-xs text-ink-subtle">{rows.length} {payables ? 'suppliers' : 'customers'} · {formatMoney(totalUsd, 'USD')} in total at USD value</p>}
            />
            <AgeingTable
              partyLabel={payables ? 'Supplier' : 'Customer'}
              documentLabel={payables ? 'Order' : 'Invoice'}
              bucketLabels={bucketLabels}
              totals={totals}
              rows={rows.map((row) => ({
                key: `${row.partyId}:${row.currency}`,
                partyName: row.partyName,
                currency: row.currency,
                ledgerHref: row.ledgerHref,
                buckets: AGEING_BUCKETS.map((b) => money(row.byBucket[b], row.currency)),
                total: formatMoney(row.total, row.currency),
                lines: row.lines.map((line) => ({
                  key: line.documentId,
                  document: line.documentLabel,
                  href: line.href,
                  date: formatDate(line.documentDate),
                  due: line.dueDate ? formatDate(line.dueDate) : '—',
                  daysOverdue: line.daysOverdue,
                  original: formatMoney(line.originalAmount, line.currency),
                  paid: formatMoney(line.paidAmount, line.currency),
                  outstanding: formatMoney(line.outstandingAmount, line.currency),
                  bucket: AGEING_LABELS[line.bucket],
                })),
              }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
