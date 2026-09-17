import Link from 'next/link';
import { getJournalForSource } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * What this document did to the ledger.
 *
 * Every posted document is the cause of at least one journal entry, and until
 * now the only way to see which was to open the journal report and search for
 * the number. That put the two halves of every question — "what does this
 * invoice say" and "what did it do to the books" — on different screens, which
 * is exactly where reconciliation arguments start.
 *
 * Amounts are shown in the currency each line was booked in, because that is
 * the figure the entry actually carries; the USD column is the translated
 * value the reports add up.
 */
export async function DocumentJournal({
  companyId,
  sourceType,
  sourceId,
  title = 'Journal',
}: {
  companyId: string;
  sourceType: string;
  sourceId: string;
  title?: string;
}) {
  const entries = await getJournalForSource({ companyId, sourceType, sourceId });

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            Nothing has been posted yet. A draft does not touch the ledger; posting writes the entry.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {entries.length === 1
            ? 'The double entry this document wrote to the ledger.'
            : `The ${entries.length} entries this document wrote to the ledger, oldest first.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {entries.map((entry) => {
          const debit = entry.lines.reduce((total, line) => total.plus(dec(line.debit)), dec(0));
          const credit = entry.lines.reduce((total, line) => total.plus(dec(line.credit)), dec(0));
          return (
            <div key={entry.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/reports/journal?q=${encodeURIComponent(entry.entryNumber)}`}
                  className="text-sm font-semibold text-forest-700 underline-offset-2 hover:underline"
                >
                  {entry.entryNumber}
                </Link>
                <span className="text-xs text-ink-muted">{formatDate(entry.entryDate)}</span>
                {entry.status !== 'POSTED' ? <Badge tone="neutral">{entry.status}</Badge> : null}
                {entry.isReversal ? <Badge tone="warning">Deletion</Badge> : null}
                <span className="text-xs text-ink-muted">{entry.description.replace(/^Reversal of/, 'Deletion of')}</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                      <th className="py-1.5 pr-3 font-medium">Account</th>
                      <th className="py-1.5 pr-3 font-medium">Detail</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Debit</th>
                      <th className="py-1.5 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line) => (
                      <tr key={line.id} className="border-b border-line/60 last:border-0">
                        <td className="py-1.5 pr-3 align-top">
                          <span className="font-mono text-xs text-ink-muted">{line.account.code}</span>{' '}
                          <span className="text-ink">{line.account.name}</span>
                        </td>
                        <td className="py-1.5 pr-3 align-top text-xs text-ink-muted">{line.description ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-right align-top tabular-nums">
                          {dec(line.debit).isZero() ? '—' : formatMoney(line.debit, line.currency)}
                        </td>
                        <td className="py-1.5 text-right align-top tabular-nums">
                          {dec(line.credit).isZero() ? '—' : formatMoney(line.credit, line.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line font-semibold">
                      <td className="py-1.5 pr-3" colSpan={2}>
                        Total
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {formatMoney(debit, entry.lines[0]?.currency ?? 'USD')}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(credit, entry.lines[0]?.currency ?? 'USD')}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
