import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getExpenseReport } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Expense Report' };
export const dynamic = 'force-dynamic';

const GROUPS = [
  { key: 'category', label: 'By category' },
  { key: 'shipment', label: 'By job' },
  { key: 'month', label: 'By month' },
] as const;

export default async function ExpenseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; groupBy?: string }>;
}) {
  const { from, to, groupBy } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);

  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();
  const grouping = (GROUPS.find((g) => g.key === groupBy)?.key ?? 'category') as 'category' | 'shipment' | 'month';

  const rows = await getExpenseReport({
    companyId: user.activeCompany.id,
    from: fromDate,
    to: toDate,
    groupBy: grouping,
  });

  const total = rows.reduce((a, r) => a.plus(r.amountUsd), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expense Report"
        description={`Posted costs · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Expenses' }]}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />
        <div className="inline-flex rounded-lg border border-line-strong p-0.5">
          {GROUPS.map((group) => (
            <Link
              key={group.key}
              href={`/reports/expenses?from=${fromDate.toISOString().slice(0, 10)}&to=${toDate.toISOString().slice(0, 10)}&groupBy=${group.key}`}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                grouping === group.key ? 'bg-navy-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {group.label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Costs {GROUPS.find((g) => g.key === grouping)?.label.toLowerCase()}</CardTitle>
          <CardDescription>
            Includes both capitalised shipment costs and period costs, so this is total spend rather than the profit
            and loss charge.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>{grouping === 'category' ? 'Category' : grouping === 'shipment' ? 'Job' : 'Month'}</TH>
                  <TH numeric>Vouchers</TH>
                  <TH numeric>Amount USD</TH>
                  <TH numeric>Share</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <TR>
                    <TD colSpan={4} className="py-8 text-center text-xs text-ink-subtle">
                      No posted expenses in this period.
                    </TD>
                  </TR>
                ) : (
                  rows.map((row) => {
                    const share = total.greaterThan(0) ? row.amountUsd.dividedBy(total).times(100) : dec(0);
                    return (
                      <TR key={row.key}>
                        <TD className="font-medium">{row.label}</TD>
                        <TD numeric>{row.count}</TD>
                        <TD numeric className="font-semibold">{formatMoney(row.amountUsd, 'USD')}</TD>
                        <TD numeric>
                          <span className="flex items-center justify-end gap-2">
                            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-navy-100">
                              <span className="block h-full bg-navy-500" style={{ width: `${Number(share)}%` }} />
                            </span>
                            <span className="text-xs text-ink-muted">{share.toFixed(1)}%</span>
                          </span>
                        </TD>
                      </TR>
                    );
                  })
                )}
              </TBody>
              <TFoot>
                <tr>
                  <TD>Total</TD>
                  <TD numeric>{rows.reduce((a, r) => a + r.count, 0)}</TD>
                  <TD numeric>{formatMoney(total, 'USD')}</TD>
                  <TD />
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
