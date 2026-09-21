import Link from 'next/link';
import { getJournalForSource } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate } from '@/lib/format';
import { businessNumber } from '@/lib/short-number';

/** FID-MA-RV-000022 → PAY 22 inside a sentence, so no system number reaches the screen. */
function shortenNumbers(text: string): string {
  return text.replace(/\bFID-[A-Z]{2,3}-[A-Z]{2,4}-\d{4,}\b/g, (match) => businessNumber(match));
}
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
  localCurrency,
}: {
  /** The company's own currency: the totals are stated in it and in USD. */
  localCurrency?: string;
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
            ? 'The double entry this document wrote to the ledger. One transaction always has two sides — what was debited and what was credited — so the same amount appears on both; it is recorded once.'
            : `The ${entries.length} entries this document wrote to the ledger, oldest first. Each has a debit side and a credit side for the same amount.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {entries.map((entry) => {
          /*
           * Totals in one currency at a time. Lines can be in different
           * currencies — a MAD receipt settles a MAD invoice and books its
           * exchange difference in USD — and adding a USD line's figure to
           * MAD ones produced "MAD 46,121.62" on a MAD 46,000 receipt. Every
           * line carries its value in the company's currency and in USD, and
           * both of those balance, so those are what is totalled.
           */
          const local = localCurrency ?? entry.lines.find((l) => l.currency !== 'USD')?.currency ?? 'USD';
          const debitLocal = entry.lines.reduce((total, line) => total.plus(dec(line.debitLocal)), dec(0));
          const creditLocal = entry.lines.reduce((total, line) => total.plus(dec(line.creditLocal)), dec(0));
          const debitUsd = entry.lines.reduce((total, line) => total.plus(dec(line.debitUsd)), dec(0));
          const creditUsd = entry.lines.reduce((total, line) => total.plus(dec(line.creditUsd)), dec(0));
          return (
            <div key={entry.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/reports/journal?q=${encodeURIComponent(entry.entryNumber)}`}
                  className="text-sm font-semibold text-forest-700 underline-offset-2 hover:underline"
                >
                  {businessNumber(entry.entryNumber)}
                </Link>
                <span className="text-xs text-ink-muted">{formatDate(entry.entryDate)}</span>
                {entry.status !== 'POSTED' ? <Badge tone="neutral">{entry.status}</Badge> : null}
                {entry.isReversal ? <Badge tone="warning">Deletion</Badge> : null}
                <span className="text-xs text-ink-muted">
                  {shortenNumbers(entry.description.replace(/^Reversal of/, 'Deletion of'))}
                </span>
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
                          
                          <span className="text-ink">{line.account.name}</span>
                        </td>
                        <td className="py-1.5 pr-3 align-top text-xs text-ink-muted">
                          {line.description ? shortenNumbers(line.description) : '—'}
                        </td>
                        <td className="py-1.5 pr-3 text-right align-top tabular-nums">
                          {dec(line.debit).isZero() ? '—' : formatMoney(line.debit, line.currency)}
                          {!dec(line.debit).isZero() && line.currency !== local && !dec(line.debitLocal).isZero() ? (
                            <span className="block text-[11px] text-ink-subtle">{formatMoney(line.debitLocal, local)}</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 text-right align-top tabular-nums">
                          {dec(line.credit).isZero() ? '—' : formatMoney(line.credit, line.currency)}
                          {!dec(line.credit).isZero() && line.currency !== local && !dec(line.creditLocal).isZero() ? (
                            <span className="block text-[11px] text-ink-subtle">{formatMoney(line.creditLocal, local)}</span>
                          ) : null}
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
                        {formatMoney(debitLocal, local)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(creditLocal, local)}
                      </td>
                    </tr>
                    {local !== 'USD' ? (
                      <tr className="text-xs text-ink-muted">
                        <td className="py-1 pr-3" colSpan={2}>
                          USD equivalent
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">{formatMoney(debitUsd, 'USD')}</td>
                        <td className="py-1 text-right tabular-nums">{formatMoney(creditUsd, 'USD')}</td>
                      </tr>
                    ) : null}
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
