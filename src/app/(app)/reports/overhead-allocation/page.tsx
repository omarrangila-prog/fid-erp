import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatDate, formatMoney } from '@/lib/format';
import {
  getAllocatableOverheads,
  getOverheadCandidates,
  listOverheadAllocations,
} from '@/lib/services/overhead-allocation';
import { PageHeader } from '@/components/shared/page-header';
import { ReportSummary } from '@/components/shared/report-summary';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { OverheadAllocationForm } from '@/app/(app)/reports/overhead-allocation/allocation-form';

export const metadata: Metadata = { title: 'Overhead Allocation' };
export const dynamic = 'force-dynamic';

const BASIS_LABEL: Record<string, string> = {
  QUANTITY: 'By weight',
  SALES_VALUE: 'By sales value',
  PERCENTAGE: 'By percentage',
  EQUAL: 'Equally',
};

function monthRange(searchFrom?: string, searchTo?: string) {
  const now = new Date();
  const from = searchFrom ? new Date(`${searchFrom}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = searchTo ? new Date(`${searchTo}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from, to };
}

/**
 * Sharing the company's overheads across shipments — for management only.
 *
 * Rent, salaries and fuel belong to the company, so they sit on the company
 * profit and loss and stay there. This screen answers the separate question
 * management asks: what did a shipment cost once its share of the office is
 * counted? Nothing here is posted, and the statutory accounts do not move.
 */
export default async function OverheadAllocationPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);
  const params = await searchParams;
  const { from, to } = monthRange(params.from, params.to);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;

  const [overheads, candidates, allocations] = await Promise.all([
    getAllocatableOverheads({ companyId, from, to }),
    getOverheadCandidates({ companyId, from, to }),
    listOverheadAllocations(companyId),
  ]);

  const active = allocations.filter((a) => a.status === 'ACTIVE');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overhead Allocation"
        description="Share the company's general expenses across shipments to see a fully absorbed cost. A management view only — nothing is posted and the company accounts do not change."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Overhead Allocation' }]}
      />

      <ReportSummary
        figures={[
          { label: 'General expenses in this period', value: formatMoney(overheads.totalUsd, 'USD'), hint: formatMoney(overheads.totalLocal, local) },
          { label: 'Expenses', value: String(overheads.expenses.length) },
          { label: 'Shipments available', value: String(candidates.length) },
          { label: 'Allocations in force', value: String(active.length) },
        ]}
      />

      <Callout tone="info" title="What this does and does not do">
        The original general expenses stay exactly where they are, on the company profit and loss, and are listed
        below unchanged. An allocation adds a management figure to each shipment&rsquo;s profitability — it is never
        posted to a ledger, so the Trial Balance, Company P&amp;L and Balance Sheet are unaffected.
      </Callout>

      {overheads.expenses.length === 0 ? (
        <EmptyState
          title="No general expenses in this period"
          description="Overheads are the company's own costs — rent, salaries, fuel, telephone. Record them as a General expense, then come back to share them across shipments."
        />
      ) : (
        <OverheadAllocationForm
          from={from.toISOString().slice(0, 10)}
          to={to.toISOString().slice(0, 10)}
          totalUsd={formatMoney(overheads.totalUsd, 'USD')}
          canAllocate={can(user, PERMISSIONS.ACCOUNTING_POST)}
          candidates={candidates.map((c) => ({
            shipmentId: c.shipmentId,
            label: `${c.reference} — Shipment ${c.ordinal}`,
            itemName: c.itemName,
            receivedKg: (c.receivedKg.greaterThan(0) ? c.receivedKg : c.orderedKg).toString(),
            salesUsd: c.salesUsd.toString(),
          }))}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>General expenses in this period</CardTitle>
          <CardDescription>Exactly as posted. An allocation does not move, change or hide any of them.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Date</TH>
                  <TH>Category</TH>
                  <TH>Memo</TH>
                  <TH numeric>Amount</TH>
                  <TH numeric>USD</TH>
                  <TH>Allocated</TH>
                </TR>
              </THead>
              <TBody>
                {overheads.expenses.map((expense) => (
                  <TR key={expense.id}>
                    <TD>{formatDate(expense.expenseDate)}</TD>
                    <TD>{expense.expenseCategory.name}</TD>
                    <TD className="text-xs text-ink-muted">{expense.description ?? '—'}</TD>
                    <TD numeric>{formatMoney(expense.amount, expense.currency)}</TD>
                    <TD numeric>{formatMoney(expense.amountUsd, 'USD')}</TD>
                    <TD className="text-xs">{expense.overheadAllocationId ? 'Counted in an allocation' : 'Not allocated'}</TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={4}>Total</TD>
                  <TD numeric>{formatMoney(overheads.totalUsd, 'USD')}</TD>
                  <TD />
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>

      {allocations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Allocations made</CardTitle>
            <CardDescription>
              The newest allocation for a period is the one in force; earlier ones are kept, marked withdrawn, so what
              management saw last time can still be read.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Period</TH>
                    <TH>Basis</TH>
                    <TH numeric>Amount</TH>
                    <TH>Shipments</TH>
                    <TH>By</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {allocations.map((allocation) => (
                    <TR key={allocation.id}>
                      <TD>
                        {formatDate(allocation.fromDate)} – {formatDate(allocation.toDate)}
                      </TD>
                      <TD>{BASIS_LABEL[allocation.basis] ?? allocation.basis}</TD>
                      <TD numeric>{formatMoney(allocation.amountUsd, 'USD')}</TD>
                      <TD className="text-xs text-ink-muted">
                        {allocation.lines
                          .map(
                            (line) =>
                              `${line.shipment.purchaseContract.contractReference} ${formatMoney(line.amountUsd, 'USD')}`,
                          )
                          .join(' · ')}
                      </TD>
                      <TD className="text-xs">{allocation.createdBy.name}</TD>
                      <TD className="text-xs">{allocation.status === 'ACTIVE' ? 'In force' : 'Withdrawn'}</TD>
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
