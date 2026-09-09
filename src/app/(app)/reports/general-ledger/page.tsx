import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getGeneralLedger } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { AccountPicker } from '@/app/(app)/reports/general-ledger/account-picker';

export const metadata: Metadata = { title: 'General Ledger' };
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const companyId = user.activeCompany.id;

  const accounts = await prisma.account.findMany({
    where: { companyId },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, type: true },
  });

  const selectedId = account && accounts.some((a) => a.id === account) ? account : accounts[0]?.id;

  const ledger = selectedId
    ? await getGeneralLedger({
        companyId,
        accountId: selectedId,
        from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        to: to ? new Date(`${to}T00:00:00.000Z`) : undefined,
      })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Ledger"
        description="Every movement through a chosen account, with a running balance in USD."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'General Ledger' }]}
      />

      <AccountPicker accounts={accounts} selectedId={selectedId ?? ''} from={from ?? ''} to={to ?? ''} />

      {!ledger ? (
        <EmptyState title="No accounts yet" description="The chart of accounts is created when a company is set up." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {ledger.account.code} · {ledger.account.name}
            </CardTitle>
            <CardDescription>{titleCase(ledger.account.type)} account</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>Description</TH>
                    <TH>Source</TH>
                    <TH numeric>Debit</TH>
                    <TH numeric>Credit</TH>
                    <TH numeric>Balance</TH>
                  </TR>
                </THead>
                <TBody>
                  <TR className="bg-navy-50/40 hover:bg-navy-50/40">
                    <TD colSpan={6} className="text-xs font-medium text-ink-muted">
                      Opening balance
                    </TD>
                    <TD numeric className="font-semibold">
                      {formatMoney(ledger.openingBalanceUsd, 'USD')}
                    </TD>
                  </TR>
                  {ledger.rows.length === 0 ? (
                    <TR>
                      <TD colSpan={7} className="py-8 text-center text-xs text-ink-subtle">
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
                        <TD numeric>{row.debitUsd.greaterThan(0) ? formatMoney(row.debitUsd, 'USD') : '—'}</TD>
                        <TD numeric>{row.creditUsd.greaterThan(0) ? formatMoney(row.creditUsd, 'USD') : '—'}</TD>
                        <TD numeric className="font-medium">{formatMoney(row.balanceUsd, 'USD')}</TD>
                      </TR>
                    ))
                  )}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={6}>Closing balance</TD>
                    <TD numeric>{formatMoney(ledger.closingBalanceUsd, 'USD')}</TD>
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
