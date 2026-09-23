import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getGeneralLedger, getGeneralLedgerByAccount } from '@/lib/services/reports';
import { LedgerGroups } from '@/app/(app)/reports/general-ledger/ledger-groups';
import { StatementHeader, FavouriteStar } from '@/components/reports/report-statement';
import {
  parseLedgerViewCurrency,
  resolveLedgerViewCurrency,
  pickCashBankCurrency,
  ledgerCurrencyLabel,
  ledgerDisplayCurrency,
} from '@/lib/ledger-currency';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { CustomizePanel } from '@/components/reports/customize-panel';
import { PrintButton } from '@/components/shared/print-button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { AccountPicker } from '@/app/(app)/reports/general-ledger/account-picker';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';
import { describeLedgerBalance } from '@/lib/ledger-meaning';
import { dec } from '@/lib/money';

export const metadata: Metadata = { title: 'General Ledger' };
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string; currency?: string }>;
}) {
  const { account, from, to, currency } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const companyId = user.activeCompany.id;

  const accounts = await prisma.account.findMany({
    where: { companyId },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      currency: true,
      systemKey: true,
      cashBankAccounts: { select: { currency: true }, orderBy: { currency: 'asc' } },
    },
  });

  const pickerAccounts = accounts.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    nativeCurrency: resolveLedgerViewCurrency({
      accountCurrency: row.currency,
      cashBankCurrency: pickCashBankCurrency(row.cashBankAccounts, row.currency),
    }),
  }));

  // "all" is the printed ledger: every account with activity, one after the other.
  const wholeBook = account === 'all';
  const selectedId = wholeBook ? undefined : account && accounts.some((a) => a.id === account) ? account : accounts[0]?.id;
  const selected = accounts.find((row) => row.id === selectedId);
  // Only what the reader asked for. Which currency an account opens in —
  // its own, its drawer's, or the one every posting on it is in — is decided
  // by the service, which can see the postings; deciding it here first meant
  // the page always won and a dirham-only account still opened at its USD
  // value.
  const requestedCurrency = parseLedgerViewCurrency(currency) ?? undefined;

  const groups = wholeBook
    ? await getGeneralLedgerByAccount({
        companyId,
        from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        to: to ? new Date(`${to}T00:00:00.000Z`) : undefined,
      })
    : null;

  const ledger = selectedId
    ? await getGeneralLedger({
        companyId,
        accountId: selectedId,
        from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        to: to ? new Date(`${to}T00:00:00.000Z`) : undefined,
        currency: requestedCurrency,
      })
    : null;

  // What it actually opened in, for the export link and the picker.
  const selectedCurrency = ledger?.viewCurrency ?? requestedCurrency ?? 'REPORTING';

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Ledger"
        description="Every movement through a chosen account. Pick USD or MAD to see that currency only — the two are never mixed into one total."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'General Ledger' }]}
        actions={
          <>
            <FavouriteStar href="/reports/general-ledger?account=all" label="General Ledger" />
            <CustomizePanel report="General Ledger" fields={['period']} />
            <ExportLinks href={exportHref('general-ledger', { account: selectedId, from, to, currency: selectedCurrency })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="General Ledger"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <AccountPicker
        accounts={pickerAccounts}
        selectedId={wholeBook ? 'all' : (selectedId ?? '')}
        from={from ?? ''}
        to={to ?? ''}
        currency={selectedCurrency}
      />

      {groups ? (
        groups.length === 0 ? (
          <EmptyState title="Nothing posted in this period" description="No account moved between these dates." />
        ) : (
          <Card>
            <CardContent className="px-2 pb-4 pt-2 sm:px-4">
              <StatementHeader
                company={user.activeCompany.name}
                title="General Ledger"
                period={from || to ? `${from ? formatDate(new Date(`${from}T00:00:00.000Z`)) : 'Start'} – ${to ? formatDate(new Date(`${to}T00:00:00.000Z`)) : 'Today'}` : 'All dates'}
                meta={<p className="text-xs text-ink-subtle">{groups.length} accounts with activity · every line at its USD value</p>}
              />
              <LedgerGroups
                groups={groups.map((g) => ({
                  accountId: g.accountId,
                  name: g.name,
                  type: g.type,
                  opening: formatMoney(g.openingUsd, 'USD'),
                  closing: formatMoney(g.closingUsd, 'USD'),
                  debit: formatMoney(g.debitUsd, 'USD'),
                  credit: formatMoney(g.creditUsd, 'USD'),
                  lines: g.lines.map((l) => ({
                    entryId: l.entryId,
                    date: formatDate(l.entryDate),
                    type: titleCase(l.sourceType.replaceAll('_', ' ')),
                    sourceType: l.sourceType,
                    sourceId: l.sourceId,
                    reference: l.reference ?? '',
                    party: l.party ?? '',
                    description: l.description,
                    debit: l.debitUsd.isZero() ? '—' : formatMoney(l.debitUsd, 'USD'),
                    credit: l.creditUsd.isZero() ? '—' : formatMoney(l.creditUsd, 'USD'),
                    balance: formatMoney(l.balanceUsd, 'USD'),
                  })),
                }))}
              />
            </CardContent>
          </Card>
        )
      ) : !ledger ? (
        <EmptyState title="No accounts yet" description="The chart of accounts is created when a company is set up." />
      ) : (
        <>
        {/*
          * What the balance means, before the rows that produce it.
          *
          * A ledger reports debits minus credits, so money the company owes
          * reads as a negative number. The client opened the account they keep
          * for Dubai, saw −50,000 and could not tell which way round it was.
          * The figure is the same; it is now said in words.
          */}
        {ledger.mixedCurrencies ? (() => {
          /*
           * A running account with one person holds whatever currency they
           * deal in, so its ledger lists each separately and never adds them
           * together. It still has to say which way round each one is: this
           * is the account the client opens to ask "what do we owe Dubai",
           * and skipping the summary here skipped it for exactly the accounts
           * the question is about.
           */
          const byCurrency = new Map<string, { debit: ReturnType<typeof dec>; credit: ReturnType<typeof dec> }>();
          for (const row of ledger.rows) {
            const seen = byCurrency.get(row.currency) ?? { debit: dec(0), credit: dec(0) };
            byCurrency.set(row.currency, {
              debit: seen.debit.plus(dec(row.debit)),
              credit: seen.credit.plus(dec(row.credit)),
            });
          }
          if (byCurrency.size === 0) return null;

          return (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[...byCurrency.entries()].map(([currency, totals]) => {
                const meaning = describeLedgerBalance(
                  totals.debit.minus(totals.credit),
                  ledger.account.type,
                  ledger.account.name,
                );
                return (
                  <Card
                    key={currency}
                    className={meaning.settled ? undefined : 'border-forest-300 bg-forest-50/40'}
                  >
                    <CardContent className="pt-5">
                      <p className="text-xs text-ink-muted">
                        {meaning.label} · {currency}
                      </p>
                      <p className="text-lg font-semibold tabular-nums text-forest-800">
                        {formatMoney(meaning.amount, currency)}
                      </p>
                      <p className="mt-1 text-[11px] text-ink-subtle">
                        {meaning.sentence} Debit {formatMoney(totals.debit, currency)}, credit{' '}
                        {formatMoney(totals.credit, currency)}.
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          );
        })() : (() => {
          const meaning = describeLedgerBalance(
            ledger.closingBalance,
            ledger.account.type,
            ledger.account.name,
          );
          const { totalDebit, totalCredit } = ledger;
          return (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-ink-muted">Opening balance</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">
                    {formatMoney(ledger.openingBalance, ledgerDisplayCurrency(ledger.viewCurrency))}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-ink-muted">Total debit</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">
                    {formatMoney(totalDebit, ledgerDisplayCurrency(ledger.viewCurrency))}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-xs text-ink-muted">Total credit</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">
                    {formatMoney(totalCredit, ledgerDisplayCurrency(ledger.viewCurrency))}
                  </p>
                </CardContent>
              </Card>
              <Card className={meaning.settled ? undefined : 'border-forest-300 bg-forest-50/40'}>
                <CardContent className="pt-5">
                  <p className="text-xs text-ink-muted">{meaning.label}</p>
                  <p className="text-lg font-semibold tabular-nums text-forest-800">
                    {formatMoney(meaning.amount, ledgerDisplayCurrency(ledger.viewCurrency))}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-subtle">{meaning.sentence}</p>
                </CardContent>
              </Card>
            </div>
          );
        })()}

        {/*
          A control account is explained by its subledger. Somebody reading
          Agent Clearing has to be able to get to the agents who hold that
          money — and to be told that they are the same balance, not a second.
        */}
        {selected?.systemKey === 'AGENT_CLEARING' || selected?.systemKey === 'AGENT_COMMISSION_PAYABLE' ? (
          <Callout tone="info" title="This account is held by named agents">
            Every figure here is also shown under the agent who holds it, on{' '}
            <Link href="/ledgers/agents" className="font-medium underline underline-offset-2">
              Agent Balances
            </Link>
            . That is the same balance seen twice — the account, and who it is with. The balance sheet counts this
            account once; the agents never add to it.
          </Callout>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>
              {ledger.account.name}
            </CardTitle>
              <CardDescription>
                {titleCase(ledger.account.type)} account · {ledgerCurrencyLabel(ledger.viewCurrency, ledger.mixedCurrencies)}
                {ledger.account.currency && ledger.account.currency !== ledger.viewCurrency && !ledger.mixedCurrencies
                  ? ` · native ${ledger.account.currency}`
                  : ''}
              </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>Memo</TH>
                    <TH>Source</TH>
                    {ledger.mixedCurrencies ? <TH>Currency</TH> : null}
                    <TH numeric>Debit</TH>
                    <TH numeric>Credit</TH>
                    {ledger.mixedCurrencies ? null : <TH numeric>Balance</TH>}
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {ledger.mixedCurrencies ? null : (
                    <TR className="bg-forest-50/40 hover:bg-forest-50/40">
                      <TD colSpan={6} className="text-xs font-medium text-ink-muted">
                        Opening balance
                      </TD>
                      <TD numeric className="font-semibold">
                        {formatMoney(ledger.openingBalance, ledgerDisplayCurrency(ledger.viewCurrency))}
                      </TD>
                      <TD />
                    </TR>
                  )}
                  {ledger.rows.length === 0 ? (
                    <TR>
                      <TD colSpan={ledger.mixedCurrencies ? 8 : 8} className="py-8 text-center text-xs text-ink-subtle">
                        No movements on this account in the selected period.
                      </TD>
                    </TR>
                  ) : (
                    ledger.rows.map((row, index) => (
                      <TR key={`${row.entryId}-${index}`}>
                        <TD>{formatDate(row.entryDate)}</TD>
                        <TD className="text-xs">{row.entryNumber}</TD>
                        <TD>
                          <span className="block">{row.description}</span>
                          {row.reference ? (
                            <span className="block text-xs text-ink-subtle">{row.reference}</span>
                          ) : null}
                        </TD>
                        <TD className="text-xs">{titleCase(row.sourceType)}</TD>
                        {ledger.mixedCurrencies ? <TD className="text-xs">{row.currency}</TD> : null}
                        <TD numeric>
                          {row.debit.greaterThan(0) ? formatMoney(row.debit, row.currency) : '—'}
                        </TD>
                        <TD numeric>
                          {row.credit.greaterThan(0) ? formatMoney(row.credit, row.currency) : '—'}
                        </TD>
                        {ledger.mixedCurrencies ? null : (
                          <TD numeric className="font-medium">
                            {formatMoney(row.balance, ledgerDisplayCurrency(ledger.viewCurrency))}
                          </TD>
                        )}
                        <TD>
                          <JournalSourceActions
                            sourceType={row.sourceType}
                            sourceId={row.sourceId}
                            entryNumber={row.entryNumber}
                            journalEntryId={row.entryId}
                            canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
                          />
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
                {ledger.mixedCurrencies ? null : (
                  <TFoot>
                    <tr>
                      <TD colSpan={6}>Closing balance</TD>
                      <TD numeric>{formatMoney(ledger.closingBalance, ledgerDisplayCurrency(ledger.viewCurrency))}</TD>
                      <TD />
                    </tr>
                  </TFoot>
                )}
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
        </>
      )}
    </div>
  );
}
