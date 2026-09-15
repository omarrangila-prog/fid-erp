import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getChartOfAccounts } from '@/lib/services/chart-of-accounts';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/feedback';
import { AddLedgerAccountButton } from '@/app/(app)/accounting/chart/add-account-button';
import { AccountRowActions } from '@/app/(app)/accounting/chart/account-row-actions';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Chart of Accounts' };
export const dynamic = 'force-dynamic';

function typeLabel(type: string) {
  return type.replaceAll('_', ' ').toLowerCase();
}

function cashBankLabel(accountType: string) {
  if (accountType === 'CASH') return 'Cash in Hand';
  if (accountType === 'PETTY_CASH') return 'Petty cash';
  return 'Bank';
}

export default async function ChartOfAccountsPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const canPost = can(user, PERMISSIONS.ACCOUNTING_POST);
  const [{ sections, localCurrency }, rates] = await Promise.all([
    getChartOfAccounts(user.activeCompany.id, user.activeCompany.localCurrency),
    getRateDefaults(user.activeCompany.id),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of Accounts"
        description="Every ledger head this company posts to — cash, banks, receivables, payables, inventory, sales, cost of sales and expenses."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Chart of Accounts' }]}
        actions={
          <>
            <PrintButton />
            {canPost ? <AddLedgerAccountButton /> : null}
          </>
        }
      />
      <PrintHeader
        title="Chart of Accounts"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <Callout tone="info" title="Posting is automatic for ordinary trade">
        A sales invoice writes receivable, sales, inventory and cost of goods sold. A customer receipt writes cash or
        bank and the customer ledger. Use a journal voucher only for adjustments, transfers and accountant entries.
        Cash and bank accounts are opened under{' '}
        <Link href="/finance/cash-bank" className="font-medium text-forest-800 hover:underline">
          Cash &amp; Bank
        </Link>
        . Customer, supplier and agent openings belong on those ledgers, not on the control account.
      </Callout>

      {sections.map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            <CardDescription>{section.hint}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Code</TH>
                    <TH>Account</TH>
                    <TH>Type</TH>
                    <TH numeric>Balance USD</TH>
                    <TH numeric>Balance {localCurrency}</TH>
                    {canPost ? <TH className="print:hidden"> </TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {section.accounts.map((account) => (
                    <TR key={account.id} className={account.status === 'INACTIVE' ? 'opacity-60' : undefined}>
                      <TD className="font-mono text-xs">{account.code}</TD>
                      <TD>
                        <Link
                          href={`/reports/general-ledger?account=${account.id}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {account.name}
                        </Link>
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {account.cashBank ? (
                            <Badge tone="info">
                              {cashBankLabel(account.cashBank.accountType)} · {account.cashBank.currency}
                            </Badge>
                          ) : null}
                          {account.systemKey ? <Badge tone="neutral">System</Badge> : null}
                          {account.expenseCategory ? (
                            <Badge tone="neutral">{account.expenseCategory.code}</Badge>
                          ) : null}
                          {account.status === 'INACTIVE' ? <Badge tone="neutral">Inactive</Badge> : null}
                        </span>
                      </TD>
                      <TD className="text-xs capitalize text-ink-muted">{typeLabel(account.type)}</TD>
                      <TD numeric>{formatMoney(account.balanceUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(account.balanceLocal, localCurrency)}</TD>
                      {canPost ? (
                        <TD className="print:hidden">
                          <AccountRowActions
                            account={{
                              id: account.id,
                              code: account.code,
                              name: account.name,
                              type: account.type,
                              reportGroup: account.reportGroup,
                              isSystem: account.isSystem,
                              status: account.status,
                              subledgerType: account.subledgerType,
                              cashBank: account.cashBank ? { id: account.cashBank.id } : null,
                            }}
                            localCurrency={localCurrency}
                            defaultLocalRate={rates.local}
                          />
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
