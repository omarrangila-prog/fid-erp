import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getCashBook } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
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

      <Card>
        <CardHeader>
          <CardTitle>{book.account.accountType === 'BANK' ? 'Bank book' : 'Cash book'}</CardTitle>
          <CardDescription>
            Opening + receipts − payments = closing, all in {currency}. This cash book and the{' '}
            {currency} general ledger for this account must agree.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {book.rows.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No movements yet" description="Posted receipts, payments and expenses appear here." />
            </div>
          ) : (
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>Memo</TH>
                    <TH>Counterparty</TH>
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
                      {formatMoney(book.openingBalance, currency)}
                    </TD>
                  </TR>
                  {book.rows.map((row) => (
                    <TR key={`${row.entryId}-${row.entryNumber}`}>
                      <TD>{formatDate(row.entryDate)}</TD>
                      <TD className="text-xs">{row.entryNumber}</TD>
                      <TD>
                        <span className="block">{row.description}</span>
                        <span className="block text-xs text-ink-subtle">{titleCase(row.sourceType)}</span>
                      </TD>
                      <TD>{row.counterparty ?? '—'}</TD>
                      <TD numeric className={row.moneyIn.greaterThan(0) ? 'text-gold-700' : 'text-ink-subtle'}>
                        {row.moneyIn.greaterThan(0) ? formatMoney(row.moneyIn, currency) : '—'}
                      </TD>
                      <TD numeric className={row.moneyOut.greaterThan(0) ? 'text-red-600' : 'text-ink-subtle'}>
                        {row.moneyOut.greaterThan(0) ? formatMoney(row.moneyOut, currency) : '—'}
                      </TD>
                      <TD numeric className="font-medium">{formatMoney(row.balance, currency)}</TD>
                      <TD>
                        <JournalSourceActions
                          sourceType={row.sourceType}
                          sourceId={row.sourceId}
                          entryNumber={row.entryNumber}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={4}>Closing balance</TD>
                    <TD numeric>{formatMoney(totalIn, currency)}</TD>
                    <TD numeric>{formatMoney(totalOut, currency)}</TD>
                    <TD numeric>{formatMoney(book.closingBalance, currency)}</TD>
                    <TD />
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
