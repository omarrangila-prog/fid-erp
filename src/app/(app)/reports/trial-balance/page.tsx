import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { AsOfPicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Trial Balance' };
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { asOf } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const asOfDate = asOf ? new Date(`${asOf}T00:00:00.000Z`) : new Date();
  const trial = await getTrialBalanceReport({ companyId: user.activeCompany.id, to: asOfDate });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trial Balance"
        description={`${user.activeCompany.name} · as at ${formatDate(asOfDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Trial Balance' }]}
        meta={
          <Badge tone={trial.isBalanced ? 'success' : 'danger'}>
            {trial.isBalanced ? 'Balanced' : 'Out of balance'}
          </Badge>
        }
      />

      <AsOfPicker defaultDate={asOfDate.toISOString().slice(0, 10)} />

      {!trial.isBalanced ? (
        <Callout tone="danger" title="Debits do not equal credits">
          This should be impossible: the posting engine refuses any entry that does not balance in USD. Check for
          data written outside the application.
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Account balances</CardTitle>
          <CardDescription>Only accounts with a balance are listed.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  <TH>Type</TH>
                  <TH numeric>Debit USD</TH>
                  <TH numeric>Credit USD</TH>
                  <TH numeric>Debit {local}</TH>
                  <TH numeric>Credit {local}</TH>
                </TR>
              </THead>
              <TBody>
                {trial.rows.map((row) => (
                  <TR key={row.accountId}>
                    <TD>
                      <Link
                        href={`/reports/general-ledger?account=${row.accountId}`}
                        className="font-medium text-forest-800 hover:text-gold-700"
                      >
                        <span className="text-ink-subtle">{row.code}</span> {row.name}
                      </Link>
                    </TD>
                    <TD className="text-xs">{titleCase(row.type)}</TD>
                    <TD numeric>{row.debitUsd.greaterThan(0) ? formatMoney(row.debitUsd, 'USD') : '—'}</TD>
                    <TD numeric>{row.creditUsd.greaterThan(0) ? formatMoney(row.creditUsd, 'USD') : '—'}</TD>
                    <TD numeric className="text-ink-muted">
                      {row.debitLocal.greaterThan(0) ? formatMoney(row.debitLocal, local) : '—'}
                    </TD>
                    <TD numeric className="text-ink-muted">
                      {row.creditLocal.greaterThan(0) ? formatMoney(row.creditLocal, local) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={2}>Total</TD>
                  <TD numeric>{formatMoney(trial.totals.debitUsd, 'USD')}</TD>
                  <TD numeric>{formatMoney(trial.totals.creditUsd, 'USD')}</TD>
                  <TD numeric>{formatMoney(trial.totals.debitLocal, local)}</TD>
                  <TD numeric>{formatMoney(trial.totals.creditLocal, local)}</TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
