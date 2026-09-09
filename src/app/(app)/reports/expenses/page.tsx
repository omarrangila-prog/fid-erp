import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getExpenseReport, getExpenseSplit, type ExpenseGrouping } from '@/lib/services/reports';
import { dec } from '@/lib/money';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Expense Report' };
export const dynamic = 'force-dynamic';

const GROUPS = [
  { key: 'type', label: 'By type' },
  { key: 'category', label: 'By category' },
  { key: 'shipment', label: 'By job' },
  { key: 'payee', label: 'By payee' },
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
  const grouping = (GROUPS.find((g) => g.key === groupBy)?.key ?? 'type') as ExpenseGrouping;

  const [rows, split] = await Promise.all([
    getExpenseReport({ companyId: user.activeCompany.id, from: fromDate, to: toDate, groupBy: grouping }),
    getExpenseSplit({ companyId: user.activeCompany.id, from: fromDate, to: toDate }),
  ]);

  const total = rows.reduce((a, r) => a.plus(r.amountUsd), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expense Report"
        description={`Posted costs · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Expenses' }]}
        actions={<PrintButton />}
      />
      <PrintHeader
        title="Expense Report"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
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
                grouping === group.key ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {group.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SplitTile
          label="Into the cost of the coffee"
          value={formatMoney(split.capitalisedUsd, 'USD')}
          note="Clearing, freight, duty and the rest. Reaches the profit and loss as cost of sales when the coffee is sold, not before."
        />
        <SplitTile
          label="Shipment costs charged to the period"
          value={formatMoney(split.shipmentPeriodUsd, 'USD')}
          note="Booked to a job so it shows on that job's cost report, but not part of what the coffee cost."
        />
        <SplitTile
          label="General company expenses"
          value={formatMoney(split.generalUsd, 'USD')}
          note="Meals, rent, utilities, travel. Nothing to do with any consignment."
        />
        <SplitTile
          label="Total cash spent"
          value={formatMoney(split.totalSpendUsd, 'USD')}
          note={`Of which ${formatMoney(split.periodChargeUsd, 'USD')} is charged to this period's profit. The rest is sitting in inventory.`}
          strong
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Costs {GROUPS.find((g) => g.key === grouping)?.label.toLowerCase()}</CardTitle>
          <CardDescription>
            Total spend, capitalised and period costs together — what left the bank, not what the profit and loss was
            charged. The four figures above separate the two.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>
                    {grouping === 'category'
                      ? 'Category'
                      : grouping === 'shipment'
                        ? 'Job'
                        : grouping === 'payee'
                          ? 'Payee'
                          : grouping === 'type'
                            ? 'Expense type'
                            : 'Month'}
                  </TH>
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
                            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-forest-100">
                              <span className="block h-full bg-forest-500" style={{ width: `${Number(share)}%` }} />
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

function SplitTile({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note: string;
  strong?: boolean;
}) {
  return (
    <div className={strong ? 'rounded-xl border border-forest-200 bg-forest-50/50 p-4' : 'rounded-xl border border-line bg-surface p-4'}>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">{note}</p>
    </div>
  );
}
