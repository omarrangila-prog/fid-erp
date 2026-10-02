import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getJournalReport } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate, formatDateTime, titleCase, dayParam, companyToday } from '@/lib/format';
import { equivalentText } from '@/lib/dual-currency';
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

  const fromDate = dayParam(from) ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  // Today on the company's own clock, not the server's: Dubai is four hours ahead of UTC.
  const toDate = dayParam(to) ?? companyToday(user.activeCompany.timezone);

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
          // A voucher is normally in one currency; say so when it is, and
          // "mixed" when a settlement genuinely spans two.
          const currencies = [...new Set(entry.lines.map((l) => l.currency))];
          /*
           * The totals in the voucher's own currency with the other one
           * underneath, both summed from what each line stored — nothing is
           * converted here. A mixed voucher has no single own currency, so it
           * reads in dollars with the company's currency underneath.
           */
          const own = currencies.length === 1 ? currencies[0] : 'USD';
          const total = (side: 'debit' | 'credit') => {
            const pick = (l: (typeof entry.lines)[number]) =>
              side === 'debit'
                ? { own: l.debit, usd: l.debitUsd, local: l.debitLocal }
                : { own: l.credit, usd: l.creditUsd, local: l.creditLocal };
            const sumOf = (key: 'own' | 'usd' | 'local') =>
              entry.lines.reduce((a, l) => a.plus(dec(pick(l)[key])), dec(0));
            const amount = currencies.length === 1 ? sumOf('own') : sumOf('usd');
            return {
              text: formatMoney(amount, own),
              equivalent: equivalentText({
                amount,
                currency: own,
                localCurrency: local,
                amountUsd: sumOf('usd'),
                amountLocal: sumOf('local'),
              }),
            };
          };
          const debitTotal = total('debit');
          const creditTotal = total('credit');
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
            totalDebit: debitTotal.text,
            totalDebitEquivalent: debitTotal.equivalent,
            totalCredit: creditTotal.text,
            totalCreditEquivalent: creditTotal.equivalent,
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
              debitEquivalent: dec(line.debit).greaterThan(0)
                ? equivalentText({
                    amount: line.debit,
                    currency: line.currency,
                    localCurrency: local,
                    amountUsd: line.debitUsd,
                    amountLocal: line.debitLocal,
                  })
                : null,
              credit: dec(line.credit).greaterThan(0) ? formatMoney(line.credit, line.currency) : '—',
              creditEquivalent: dec(line.credit).greaterThan(0)
                ? equivalentText({
                    amount: line.credit,
                    currency: line.currency,
                    localCurrency: local,
                    amountUsd: line.creditUsd,
                    amountLocal: line.creditLocal,
                  })
                : null,
            })),
          };
        })}
        canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
      />
    </div>
  );
}
