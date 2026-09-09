import type { Metadata } from 'next';
import Link from 'next/link';
import { Wallet, Landmark, Coins } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getFinancialPosition } from '@/lib/services/reports';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { CashBankAccountButton } from '@/app/(app)/finance/cash-bank/account-button';

export const metadata: Metadata = { title: 'Cash & Bank' };
export const dynamic = 'force-dynamic';

const TYPE_ICONS = { CASH: Wallet, PETTY_CASH: Coins, BANK: Landmark } as const;

export default async function CashBankPage() {
  const user = await requirePageAccess(PERMISSIONS.CASHBANK_VIEW);
  const position = await getFinancialPosition({ companyId: user.activeCompany.id });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash & Bank"
        description="Every account in its own currency. Balances come from posted transactions, never from a stored total."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Cash & Bank' }]}
        actions={can(user, PERMISSIONS.CASHBANK_MANAGE) ? <CashBankAccountButton /> : undefined}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {position.currencyTotals.map((total) => (
          <Card key={total.currency} className="p-4">
            <p className="text-xs font-medium text-ink-muted">Total {total.currency}</p>
            <p className="tnum mt-1 text-xl font-semibold text-ink">{formatMoney(total.total, total.currency)}</p>
            <p className="mt-1 text-xs text-ink-subtle">
              Cash {formatMoney(total.cash, total.currency)} · Bank {formatMoney(total.bank, total.currency)}
            </p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Currencies are never merged into one figure — a total across AED and USD would mean nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  <TH>Type</TH>
                  <TH>Currency</TH>
                  <TH numeric>Balance</TH>
                  <TH numeric>USD equivalent</TH>
                </TR>
              </THead>
              <TBody>
                {position.accounts.map((account) => {
                  const Icon = TYPE_ICONS[account.accountType as keyof typeof TYPE_ICONS] ?? Landmark;
                  return (
                    <TR key={account.accountId}>
                      <TD>
                        <Link
                          href={`/finance/cash-bank/${account.accountId}`}
                          className="flex items-center gap-2 font-medium text-forest-800 hover:text-gold-700"
                        >
                          <Icon className="size-4 text-forest-400" />
                          <span>
                            <span className="block">{account.name}</span>
                            <span className="block text-xs font-normal text-ink-subtle">{account.code}</span>
                          </span>
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={account.accountType === 'BANK' ? 'info' : 'neutral'}>
                          {account.accountType.replaceAll('_', ' ').toLowerCase()}
                        </Badge>
                      </TD>
                      <TD>{account.currency}</TD>
                      <TD numeric className="font-semibold">
                        {formatMoney(account.balance, account.currency)}
                      </TD>
                      <TD numeric className="text-ink-muted">
                        {account.currency === 'USD' ? '—' : formatMoney(account.balanceUsd, 'USD')}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
