import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getJournalReport } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate, formatDateTime, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { JournalClient } from '@/app/(app)/reports/journal/journal-client';
import { DateRangePicker } from '@/components/shared/date-range';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Journal' };
export const dynamic = 'force-dynamic';

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; q?: string }>;
}) {
  const { from, to, q } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();

  const entries = await getJournalReport({
    companyId: user.activeCompany.id,
    from: fromDate,
    to: toDate,
    q,
    limit: q?.trim() ? 500 : 200,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal"
        description={`Every posted entry with its lines · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Journal' }]}
        actions={
          <>
            {can(user, PERMISSIONS.ACCOUNTING_POST) ? (
              <Button asChild variant="accent" size="sm">
                <Link href="/accounting/journal/new">
                  <Plus />
                  New entry
                </Link>
              </Button>
            ) : null}
            <ExportLinks href={exportHref('journal', { from, to })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Journal"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      <JournalClient
        rows={entries.map((entry) => {
          const debits = entry.lines.reduce((a, l) => a.plus(dec(l.debitUsd)), dec(0));
          const credits = entry.lines.reduce((a, l) => a.plus(dec(l.creditUsd)), dec(0));
          // A voucher is normally in one currency; say so when it is, and
          // "mixed" when a settlement genuinely spans two.
          const currencies = [...new Set(entry.lines.map((l) => l.currency))];
          return {
            id: entry.id,
            entryNumber: entry.entryNumber,
            entryDate: formatDate(entry.entryDate),
            entryDateSort: entry.entryDate.getTime(),
            description: entry.description,
            reference: entry.reference,
            sourceType: entry.sourceType,
            sourceTypeLabel: titleCase(entry.sourceType),
            sourceId: entry.sourceId,
            currency: currencies.length === 1 ? currencies[0] : 'mixed',
            totalDebit: formatMoney(debits, 'USD'),
            totalCredit: formatMoney(credits, 'USD'),
            totalSort: Number(debits),
            isReversal: entry.isReversal,
            createdBy: entry.createdBy.name,
            postedAt: formatDateTime(entry.createdAt),
            lines: entry.lines.map((line) => ({
              id: line.id,
              accountCode: line.account.code,
              accountName: line.account.name,
              description: line.description,
              currency: line.currency,
              debit: dec(line.debit).greaterThan(0) ? formatMoney(line.debit, line.currency) : '—',
              credit: dec(line.credit).greaterThan(0) ? formatMoney(line.credit, line.currency) : '—',
              usd: dec(line.debitUsd).greaterThan(0)
                ? formatMoney(line.debitUsd, 'USD')
                : dec(line.creditUsd).greaterThan(0)
                  ? `(${formatMoney(line.creditUsd, 'USD')})`
                  : '—',
              local: dec(line.debitLocal).greaterThan(0)
                ? formatMoney(line.debitLocal, local)
                : dec(line.creditLocal).greaterThan(0)
                  ? `(${formatMoney(line.creditLocal, local)})`
                  : '—',
            })),
          };
        })}
        localCurrency={local}
        canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
      />
    </div>
  );
}
