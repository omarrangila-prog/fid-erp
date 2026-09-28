import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getCashBook } from '@/lib/services/reports';
import { formatMoney, titleCase } from '@/lib/format';
import { businessNumber } from '@/lib/short-number';
import { LedgerReport } from '@/components/ledger/ledger-report';
import { getLedgerPrefs } from '@/lib/services/ledger-prefs';
import type { LedgerColumnKey } from '@/lib/ledger-columns';

const CASH_LEDGER_COLUMNS: LedgerColumnKey[] = ['reference', 'jv', 'type', 'party'];
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';
import { EditCashBankAccountButton } from '@/app/(app)/finance/cash-bank/account-button';
import { ledgerHref } from '@/lib/ledger-currency';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const account = await prisma.cashBankAccount.findUnique({ where: { id }, select: { name: true } });
  return { title: account?.name ?? 'Account' };
}

export default async function CashBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.CASHBANK_VIEW);

  const exists = await prisma.cashBankAccount.findFirst({
    where: { id, companyId: user.activeCompany.id },
  });
  if (!exists) notFound();

  const book = await getCashBook({ companyId: user.activeCompany.id, cashBankAccountId: id });
  const currency = book.account.currency;

  const totalIn = book.rows.reduce((a, r) => a.plus(r.moneyIn), book.openingBalance.minus(book.openingBalance));
  const totalOut = book.rows.reduce((a, r) => a.plus(r.moneyOut), book.openingBalance.minus(book.openingBalance));
  const canManage = can(user, PERMISSIONS.CASHBANK_MANAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        title={book.account.name}
        description={`${book.account.currency} · ${book.account.accountType.replaceAll('_', ' ').toLowerCase()}`}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Cash & Bank', href: '/finance/cash-bank' },
          { label: book.account.name },
        ]}
        meta={
          <>
            <Badge tone="neutral">{currency}</Badge>
            <Badge tone={exists.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {exists.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </Badge>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href={ledgerHref(exists.glAccountId, currency)}>View general ledger</Link>
            </Button>
            {canManage ? (
              <EditCashBankAccountButton
                localCurrency={user.activeCompany.localCurrency}
                account={{
                  id: exists.id,
                  code: exists.code,
                  name: exists.name,
                  accountType: exists.accountType,
                  currency: exists.currency,
                  openingBalance: exists.openingBalance.toString(),
                  bankName: exists.bankName,
                  accountNumber: exists.accountNumber,
                  status: exists.status,
                }}
              />
            ) : null}
          </div>
        }
      />

      <MetricGrid className="lg:grid-cols-4">
        <Metric label="Opening balance" value={formatMoney(book.openingBalance, currency)} tone="muted" />
        <Metric label="Money in" value={formatMoney(totalIn, currency)} tone="positive" />
        <Metric label="Money out" value={formatMoney(totalOut, currency)} tone="negative" />
        <Metric label="Closing balance" value={formatMoney(book.closingBalance, currency)} />
      </MetricGrid>

      {/* The same ledger as every other: Debit is money in, Credit is money out. */}
      <LedgerReport
        report="cash-bank"
        title={book.account.accountType === 'BANK' ? 'Bank ledger' : 'Cash ledger'}
        subject={book.account.name}
        currency={currency}
        balanceSide="debit"
        opening={book.openingBalance.toString()}
        rows={book.rows.map((row) => ({
          key: `${row.entryId}-${row.entryNumber}`,
          date: row.entryDate.toISOString().slice(0, 10),
          reference: businessNumber(row.reference ?? row.entryNumber),
          jv: businessNumber(row.entryNumber),
          type: titleCase(row.sourceType),
          memo: row.description,
          party: row.counterparty,
          debit: row.moneyIn.toString(),
          credit: row.moneyOut.toString(),
          balance: row.balance.toString(),
          actions: (
            <JournalSourceActions
              sourceType={row.sourceType}
              sourceId={row.sourceId}
              entryNumber={row.entryNumber}
              journalEntryId={row.entryId}
              canDelete={can(user, PERMISSIONS.ACCOUNTING_POST)}
            />
          ),
        }))}
        available={CASH_LEDGER_COLUMNS}
        initialPrefs={await getLedgerPrefs(user.id, 'cash-bank', CASH_LEDGER_COLUMNS)}
        companyName={user.activeCompany.name}
        emptyText="Posted receipts, payments and expenses appear here."
      />
    </div>
  );
}
