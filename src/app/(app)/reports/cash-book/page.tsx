import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getCashBook } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { dec, sum } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';

export const metadata: Metadata = { title: 'Cash Book & Bank Book' };
export const dynamic = 'force-dynamic';

/**
 * The cash book and the bank book, which are the same report read twice.
 *
 * One drawer or one account at a time, every movement through it in date
 * order, with what went in, what went out and what was left after each. This
 * is the report a trader checks against a bank statement, so it shows what the
 * statement shows — money in, money out, running balance — rather than debits
 * and credits.
 *
 * It is drawn from the posted journal, not from a separate running total, so
 * it cannot drift from the general ledger.
 */
export default async function CashBookPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.CASHBANK_VIEW);
  const companyId = user.activeCompany.id;

  const accounts = await prisma.cashBankAccount.findMany({
    where: { companyId, status: 'ACTIVE' },
    orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
    select: { id: true, code: true, name: true, currency: true, accountType: true },
  });

  const selectedId = account && accounts.some((a) => a.id === account) ? account : accounts[0]?.id;

  const book = selectedId
    ? await getCashBook({
        companyId,
        cashBankAccountId: selectedId,
        from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
      })
    : null;

  const totalIn = book ? sum(book.rows.map((r) => dec(r.moneyIn))) : dec(0);
  const totalOut = book ? sum(book.rows.map((r) => dec(r.moneyOut))) : dec(0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash Book & Bank Book"
        description="Every movement through one drawer or account, the way a bank statement reads it: in, out, and what was left."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Cash Book' }]}
        actions={<PrintButton />}
      />
      <PrintHeader
        title="Cash Book & Bank Book"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="No cash or bank account yet"
          description="Open one from Cash & Bank and its movements will appear here."
        />
      ) : (
        <>
          {/* Each account is its own book. Choosing one is the whole filter,
              so it is a row of buttons rather than a dropdown to open. */}
          <div className="flex flex-wrap gap-2 print:hidden">
            {accounts.map((a) => {
              const params = new URLSearchParams();
              params.set('account', a.id);
              if (from) params.set('from', from);
              if (to) params.set('to', to);
              return (
                <Link
                  key={a.id}
                  href={`/reports/cash-book?${params.toString()}`}
                  className={cn(
                    'rounded-xl border-2 px-3 py-2 text-sm transition-colors',
                    a.id === selectedId
                      ? 'border-forest-500 bg-forest-50/60 font-semibold text-ink'
                      : 'border-line bg-surface text-ink-muted hover:border-forest-300',
                  )}
                >
                  {a.name}
                  <span className="ml-1.5 text-xs text-ink-subtle">{a.currency}</span>
                </Link>
              );
            })}
          </div>

          <div className="print:hidden">
            <DateRangePicker defaultFrom={from ?? ''} defaultTo={to ?? ''} />
          </div>

          {book ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardContent className="pt-5">
                    <p className="text-xs text-ink-muted">Opening balance</p>
                    <p className="text-lg font-semibold tabular-nums text-ink">
                      {formatMoney(book.openingBalance, book.account.currency)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-5">
                    <p className="text-xs text-ink-muted">Money in</p>
                    <p className="text-lg font-semibold tabular-nums text-forest-800">
                      {formatMoney(totalIn, book.account.currency)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-5">
                    <p className="text-xs text-ink-muted">Money out</p>
                    <p className="text-lg font-semibold tabular-nums text-ink">
                      {formatMoney(totalOut, book.account.currency)}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border-forest-300 bg-forest-50/40">
                  <CardContent className="pt-5">
                    <p className="text-xs text-ink-muted">Balance now</p>
                    <p className="text-lg font-semibold tabular-nums text-forest-800">
                      {formatMoney(book.closingBalance, book.account.currency)}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {book.account.name} · {book.account.currency}
                  </CardTitle>
                  <CardDescription>
                    {titleCase(book.account.accountType)} account. Every line below is a posted journal entry, so
                    this book and the general ledger can never disagree.
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <TableWrap className="rounded-none border-0 border-t">
                    <Table>
                      <THead>
                        <TR className="hover:bg-transparent">
                          <TH>Date</TH>
                          <TH>Entry</TH>
                          <TH>Description</TH>
                          <TH>Who</TH>
                          <TH>Source</TH>
                          <TH numeric>In</TH>
                          <TH numeric>Out</TH>
                          <TH numeric>Balance</TH>
                          <TH className="text-right">Actions</TH>
                        </TR>
                      </THead>
                      <TBody>
                        <TR className="bg-forest-50/40 hover:bg-forest-50/40">
                          <TD colSpan={7} className="text-xs font-medium text-ink-muted">
                            Opening balance
                          </TD>
                          <TD numeric className="font-semibold">
                            {formatMoney(book.openingBalance, book.account.currency)}
                          </TD>
                          <TD />
                        </TR>
                        {book.rows.length === 0 ? (
                          <TR>
                            <TD colSpan={9} className="py-8 text-center text-xs text-ink-subtle">
                              Nothing moved through this account in the period chosen.
                            </TD>
                          </TR>
                        ) : (
                          book.rows.map((row, index) => (
                            <TR key={`${row.entryId}-${index}`}>
                              <TD>{formatDate(row.entryDate)}</TD>
                              <TD className="text-xs">{row.entryNumber}</TD>
                              <TD>{row.description}</TD>
                              <TD className="text-xs text-ink-muted">{row.counterparty ?? '—'}</TD>
                              <TD className="text-xs">{titleCase(row.sourceType)}</TD>
                              <TD numeric className="text-forest-800">
                                {dec(row.moneyIn).greaterThan(0)
                                  ? formatMoney(row.moneyIn, book.account.currency)
                                  : '—'}
                              </TD>
                              <TD numeric>
                                {dec(row.moneyOut).greaterThan(0)
                                  ? formatMoney(row.moneyOut, book.account.currency)
                                  : '—'}
                              </TD>
                              <TD numeric className="font-medium">
                                {formatMoney(row.balance, book.account.currency)}
                              </TD>
                              <TD>
                                <JournalSourceActions
                                  sourceType={row.sourceType}
                                  sourceId={row.sourceId}
                                  entryNumber={row.entryNumber}
                                />
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                      <TFoot>
                        <tr>
                          <TD colSpan={5}>Closing balance</TD>
                          <TD numeric>{formatMoney(totalIn, book.account.currency)}</TD>
                          <TD numeric>{formatMoney(totalOut, book.account.currency)}</TD>
                          <TD numeric>{formatMoney(book.closingBalance, book.account.currency)}</TD>
                          <TD />
                        </tr>
                      </TFoot>
                    </Table>
                  </TableWrap>
                </CardContent>
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
