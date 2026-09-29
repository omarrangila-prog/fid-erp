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
  ledgerDisplayCurrency,
  ledgerCurrencyLabel,
} from '@/lib/ledger-currency';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { CustomizePanel } from '@/components/reports/customize-panel';
import { PrintButton } from '@/components/shared/print-button';
import { ReportShareButton } from '@/components/share/report-share-button';
import { Card, CardContent } from '@/components/ui/card';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { AccountPicker } from '@/app/(app)/reports/general-ledger/account-picker';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';
import { describeLedgerBalance } from '@/lib/ledger-meaning';
import { dec } from '@/lib/money';
import { journalSourceHref } from '@/lib/journal-source';
import { businessNumber } from '@/lib/short-number';
import { LedgerReport } from '@/components/ledger/ledger-report';
import { getLedgerPrefs } from '@/lib/services/ledger-prefs';
import type { LedgerColumnKey } from '@/lib/ledger-columns';
import { windowLedger } from '@/lib/ledger-window';

const GL_COLUMNS: LedgerColumnKey[] = ['reference', 'jv', 'type', 'party', 'currency'];

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

  const glPrefs = await getLedgerPrefs(user.id, 'general-ledger', GL_COLUMNS);

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
            <ReportShareButton report="general-ledger" />
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
        localCurrency={user.activeCompany.localCurrency}
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
                meta={
                  <p className="text-xs text-ink-subtle">
                    {groups.length} accounts with activity · in {user.activeCompany.localCurrency}, the currency the books are kept in, every
                    line at its own rate · open an account to read it in its own currency
                  </p>
                }
              />
              <LedgerGroups
                currency={user.activeCompany.localCurrency}
                prefs={glPrefs}
                available={GL_COLUMNS}
                companyName={user.activeCompany.name}
                groups={groups.map((g) => {
                  const sent = windowLedger(
                    g.lines.map((l, i) => ({
                      key: `${l.entryId}-${i}`,
                      date: l.entryDate.toISOString().slice(0, 10),
                      reference: l.reference || null,
                      referenceHref: journalSourceHref(l.sourceType, l.sourceId),
                      type: titleCase(l.sourceType.replaceAll('_', ' ')),
                      memo: l.description,
                      party: l.party || null,
                      debit: l.debitLocal.toString(),
                      credit: l.creditLocal.toString(),
                      balance: l.balanceLocal.toString(),
                    })),
                    g.openingLocal.toString(),
                    {},
                  );
                  return {
                    accountId: g.accountId,
                    name: g.name,
                    type: g.type,
                    opening: formatMoney(g.openingLocal, user.activeCompany.localCurrency),
                    closing: formatMoney(g.closingLocal, user.activeCompany.localCurrency),
                    debit: formatMoney(g.debitLocal, user.activeCompany.localCurrency),
                    credit: formatMoney(g.creditLocal, user.activeCompany.localCurrency),
                    openingRaw: sent.opening,
                    rows: sent.rows,
                    window: sent.window,
                  };
                })}
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
          // The figures are in the ledger below; this says which way round the balance is.
          const meaning = describeLedgerBalance(ledger.closingBalance, ledger.account.type, ledger.account.name);
          return (
            <Card className={meaning.settled ? undefined : 'border-forest-300 bg-forest-50/40'} data-testid="ledger-meaning">
              <CardContent className="pt-5">
                <p className="text-xs text-ink-muted">{meaning.label}</p>
                <p className="text-lg font-semibold tabular-nums text-forest-800">
                  {formatMoney(meaning.amount, ledgerDisplayCurrency(ledger.viewCurrency))}
                </p>
                <p className="mt-1 text-[11px] text-ink-subtle">{meaning.sentence}</p>
              </CardContent>
            </Card>
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

        <p className="text-sm text-ink-muted" data-testid="ledger-currency-label">
          <span className="font-semibold text-ink">{ledger.account.name}</span> · {titleCase(ledger.account.type)} account ·{' '}
          {ledgerCurrencyLabel(ledger.viewCurrency, ledger.mixedCurrencies)}
          {ledger.account.currency && ledger.account.currency !== ledger.viewCurrency && !ledger.mixedCurrencies
            ? ` · native ${ledger.account.currency}`
            : ''}
        </p>
        {(ledger.mixedCurrencies
          ? // A running account in several currencies: one ledger per currency, never added together.
            [...new Set(ledger.rows.map((row) => row.currency))].sort().map((code) => {
              let running = dec(0);
              return {
                currency: code,
                opening: '0',
                rows: ledger.rows
                  .filter((row) => row.currency === code)
                  .map((row, index) => {
                    running = running.plus(dec(row.debit)).minus(dec(row.credit));
                    return { row, index, balance: running.toString() };
                  }),
              };
            })
          : [
              {
                currency: ledgerDisplayCurrency(ledger.viewCurrency),
                opening: ledger.openingBalance.toString(),
                rows: ledger.rows.map((row, index) => ({ row, index, balance: row.balance.toString() })),
              },
            ]
        ).map((book) => {
          // Only the latest entries of the dates asked for travel to the browser; the rest are brought forward.
          const sent = windowLedger(
            book.rows.map(({ row, index, balance }) => ({
              key: `${row.entryId}-${index}`,
              date: row.entryDate.toISOString().slice(0, 10),
              reference: row.reference ?? businessNumber(row.entryNumber),
              referenceHref: journalSourceHref(row.sourceType, row.sourceId),
              jv: businessNumber(row.entryNumber),
              type: titleCase(row.sourceType),
              memo: row.description,
              currency: row.currency,
              debit: row.debit.toString(),
              credit: row.credit.toString(),
              balance,
              actions: (
                <JournalSourceActions
                  sourceType={row.sourceType}
                  sourceId={row.sourceId}
                  entryNumber={row.entryNumber}
                  journalEntryId={row.entryId}
                  canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
                />
              ),
            })),
            book.opening,
            {},
          );
          return (
            <LedgerReport
              key={book.currency}
              report="general-ledger"
              title="General ledger"
              subject={`${ledger.account.name} · ${titleCase(ledger.account.type)} account`}
              currency={book.currency}
              balanceSide="debit"
              opening={sent.opening}
              rows={sent.rows}
              window={{ ...sent.window, from, to }}
              available={GL_COLUMNS}
              initialPrefs={glPrefs}
              companyName={user.activeCompany.name}
              periodLabel={from || to ? `${from ?? 'the start'} – ${to ?? 'today'}` : undefined}
              dateFilter={false}
              emptyText="No movements on this account in the selected period."
            />
          );
        })}
        </>
      )}
    </div>
  );
}
