import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getFinancialPosition } from '@/lib/services/reports';
import { getWarehouseStock } from '@/lib/services/dashboard';
import { formatMoney, formatQuantityKg, formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Financial Position' };
export const dynamic = 'force-dynamic';

export default async function FinancialPositionPage() {
  const user = await requirePageAccess(PERMISSIONS.CASHBANK_VIEW);
  const companyId = user.activeCompany.id;
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [position, warehouses] = await Promise.all([
    getFinancialPosition({ companyId }),
    getWarehouseStock(companyId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial Position"
        description={`${position.companyName} — what the company holds, owes and is owed, right now.`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Financial Position' }]}
        meta={<span className="text-xs text-ink-subtle">As at {formatDateTime(new Date())}</span>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Money</CardTitle>
            <CardDescription>Each account in its own currency, never merged into one figure.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Account</TH>
                    <TH>Type</TH>
                    <TH numeric>Balance</TH>
                  </TR>
                </THead>
                <TBody>
                  {position.accounts.map((account) => (
                    <TR key={account.accountId}>
                      <TD>
                        <Link
                          href={`/finance/cash-bank/${account.accountId}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {account.name}
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={account.accountType === 'BANK' ? 'info' : 'neutral'}>
                          {account.accountType.replaceAll('_', ' ').toLowerCase()}
                        </Badge>
                      </TD>
                      <TD numeric className="font-semibold">
                        {formatMoney(account.balance, account.currency)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  {position.currencyTotals.map((total) => (
                    <tr key={total.currency}>
                      <TD colSpan={2}>Total {total.currency}</TD>
                      <TD numeric>{formatMoney(total.total, total.currency)}</TD>
                    </tr>
                  ))}
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Owed to us and by us</CardTitle>
              <CardDescription>In USD, the group reporting currency.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { label: 'Customer receivables', value: position.receivableUsd, href: '/finance/receivables', tone: 'text-ink' },
                { label: 'Supplier payables', value: position.payableUsd, href: '/finance/payables', tone: 'text-ink' },
                { label: 'Cheques on hand', value: position.chequesOnHandUsd, href: '/finance/cheques', tone: 'text-ink-muted' },
              ].map((row) => (
                <Link
                  key={row.label}
                  href={row.href}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="text-sm text-ink">{row.label}</span>
                  <span className={`tnum text-sm font-semibold ${row.tone}`}>{formatMoney(row.value, 'USD')}</span>
                </Link>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Coffee</CardTitle>
              <CardDescription>Stock on hand and stock still on the water.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
                <span className="text-sm text-ink">
                  Available stock
                  <span className="block text-xs text-ink-subtle">{position.bags.toLocaleString()} bags</span>
                </span>
                <span className="text-right">
                  <span className="tnum block text-sm font-semibold">{formatQuantityKg(position.availableKg)}</span>
                  {showValue ? (
                    <span className="tnum block text-xs text-ink-subtle">
                      {formatMoney(position.inventoryValueUsd, 'USD')}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">
                  In transit
                  <span className="block text-xs text-ink-subtle">Owned, not yet landed</span>
                </span>
                <span className="text-right">
                  <span className="tnum block text-sm font-semibold">{formatQuantityKg(position.inTransitKg)}</span>
                  {showValue ? (
                    <span className="tnum block text-xs text-ink-subtle">
                      {formatMoney(position.inTransitValueUsd, 'USD')}
                    </span>
                  ) : null}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {warehouses.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Stock by warehouse</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Warehouse</TH>
                    <TH numeric>On hand</TH>
                    <TH numeric>Available</TH>
                    <TH numeric>Bags</TH>
                    {showValue ? <TH numeric>Value</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {warehouses.map((w) => (
                    <TR key={w.warehouseId}>
                      <TD className="font-medium">{w.name}</TD>
                      <TD numeric>{formatQuantityKg(w.onHandKg)}</TD>
                      <TD numeric>{formatQuantityKg(w.availableKg)}</TD>
                      <TD numeric>{w.bags.toLocaleString()}</TD>
                      {showValue ? <TD numeric>{formatMoney(w.valueUsd, 'USD')}</TD> : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
