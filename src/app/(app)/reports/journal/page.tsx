import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getJournalReport } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate, formatDateTime, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Journal' };
export const dynamic = 'force-dynamic';

export default async function JournalPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();

  const entries = await getJournalReport({ companyId: user.activeCompany.id, from: fromDate, to: toDate, limit: 200 });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal"
        description={`Every posted entry with its lines · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Journal' }]}
        actions={<PrintButton />}
      />
      <PrintHeader
        title="Journal"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      {entries.length === 0 ? (
        <EmptyState title="No entries in this period" description="Post a document to create journal entries." />
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const debits = entry.lines.reduce((a, l) => a.plus(dec(l.debitUsd)), dec(0));
            return (
              <Card key={entry.id}>
                <CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle>
                      {entry.entryNumber}
                      {entry.isReversal ? (
                        <Badge tone="danger" className="ml-2">
                          Reversal
                        </Badge>
                      ) : null}
                    </CardTitle>
                    <CardDescription>{entry.description}</CardDescription>
                  </div>
                  <div className="shrink-0 text-right text-xs text-ink-muted">
                    <p>{formatDate(entry.entryDate)}</p>
                    <p>
                      {titleCase(entry.sourceType)} · {entry.createdBy.name}
                    </p>
                    <p className="tnum font-semibold text-ink">{formatMoney(debits, 'USD')}</p>
                  </div>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <TableWrap className="rounded-none border-0 border-t">
                    <Table>
                      <THead>
                        <TR className="hover:bg-transparent">
                          <TH>Account</TH>
                          <TH>Description</TH>
                          <TH numeric>Debit</TH>
                          <TH numeric>Credit</TH>
                          <TH numeric>USD</TH>
                          <TH numeric>{local}</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {entry.lines.map((line) => (
                          <TR key={line.id}>
                            <TD>
                              <span className="text-ink-subtle">{line.account.code}</span> {line.account.name}
                            </TD>
                            <TD className="text-xs text-ink-muted">{line.description ?? '—'}</TD>
                            <TD numeric>
                              {dec(line.debit).greaterThan(0) ? formatMoney(line.debit, line.currency) : '—'}
                            </TD>
                            <TD numeric>
                              {dec(line.credit).greaterThan(0) ? formatMoney(line.credit, line.currency) : '—'}
                            </TD>
                            <TD numeric className="text-ink-muted">
                              {dec(line.debitUsd).greaterThan(0)
                                ? formatMoney(line.debitUsd, 'USD')
                                : dec(line.creditUsd).greaterThan(0)
                                  ? `(${formatMoney(line.creditUsd, 'USD')})`
                                  : '—'}
                            </TD>
                            <TD numeric className="text-ink-muted">
                              {dec(line.debitLocal).greaterThan(0)
                                ? formatMoney(line.debitLocal, local)
                                : dec(line.creditLocal).greaterThan(0)
                                  ? `(${formatMoney(line.creditLocal, local)})`
                                  : '—'}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </TableWrap>
                  <p className="px-5 py-2 text-xs text-ink-subtle">Posted {formatDateTime(entry.postedAt)}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
