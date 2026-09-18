import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getPurchaseRegister } from '@/lib/services/reports';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { dec, sum } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { ExportLinks } from '@/components/shared/export-links';
import { exportHref } from '@/components/shared/excel-link';
import { PrintHeader } from '@/components/shared/print-header';
import { DateRangePicker } from '@/components/shared/date-range';

export const metadata: Metadata = { title: 'Purchase Report' };
export const dynamic = 'force-dynamic';

/**
 * Every purchase in a period: from whom, how much coffee, what it cost, how
 * much has landed and how much is still owed.
 *
 * "Landed" is what the goods receipts say arrived, not what was contracted.
 * Coffee is bought months before it turns up, and showing the contracted
 * tonnage as though it were in the warehouse would answer a different question
 * from the one being asked.
 */
export default async function PurchaseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);

  const rows = await getPurchaseRegister({
    companyId: user.activeCompany.id,
    from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
    to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
  });

  const totalUsd = sum(rows.map((r) => dec(r.totalUsd)));
  const owedUsd = sum(
    rows.map((r) =>
      dec(r.total).isZero() ? dec(0) : dec(r.outstanding).dividedBy(dec(r.total)).times(dec(r.totalUsd)),
    ),
  );
  const bought = sum(rows.map((r) => dec(r.quantityKg)));
  const landed = sum(rows.map((r) => dec(r.receivedKg)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Report"
        description="Every purchase in the period, how much of it has landed, and how much is still owed to the supplier."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Purchases' }]}
        actions={<ExportLinks href={exportHref('purchase-register', { from, to })} />}
      />
      <PrintHeader title="Purchase Report" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="print:hidden">
        <DateRangePicker defaultFrom={from ?? ''} defaultTo={to ?? ''} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Coffee bought', value: formatQuantityKg(bought), tone: 'text-ink' },
          { label: 'Landed so far', value: formatQuantityKg(landed), tone: 'text-forest-800' },
          { label: 'Purchase value', value: formatMoney(totalUsd, 'USD'), tone: 'text-ink' },
          { label: 'Still owed', value: formatMoney(owedUsd, 'USD'), tone: 'text-forest-800' },
        ].map((card) => (
          <Card key={card.label}>
            <CardContent className="pt-5">
              <p className="text-xs text-ink-muted">{card.label}</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums ${card.tone}`}>{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No purchases in this period"
          description="Change the dates above, or raise a purchase contract and it will appear here."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{rows.length} {rows.length === 1 ? 'contract' : 'contracts'}</CardTitle>
            <CardDescription>
              Each row opens the contract it came from. Amounts are in the currency each was agreed in; the totals
              above are stated in USD so they can be added together.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Contract</TH>
                    <TH>Supplier</TH>
                    <TH>Origin</TH>
                    <TH numeric>Bought KG</TH>
                    <TH numeric>Landed KG</TH>
                    <TH numeric>Goods</TH>
                    <TH numeric>Freight</TH>
                    <TH numeric>Total</TH>
                    <TH numeric>Outstanding</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.contractId}>
                      <TD>{formatDate(row.contractDate)}</TD>
                      <TD>
                        <Link
                          href={`/purchases/${row.contractId}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {row.contractNumber}
                        </Link>
                        <span className="block text-xs text-ink-subtle">{row.contractReference}</span>
                      </TD>
                      <TD>
                        <Link
                          href={`/ledgers/vendors/${row.vendorId}`}
                          className="text-forest-800 hover:text-gold-700"
                        >
                          {row.vendorName}
                        </Link>
                      </TD>
                      <TD className="text-xs text-ink-muted">{row.origin ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(row.quantityKg)}</TD>
                      <TD numeric className="text-forest-800">{formatQuantityKg(row.receivedKg)}</TD>
                      <TD numeric>{formatMoney(row.goodsValue, row.currency)}</TD>
                      <TD numeric>{formatMoney(row.freight, row.currency)}</TD>
                      <TD numeric>{formatMoney(row.total, row.currency)}</TD>
                      <TD numeric className="font-medium">{formatMoney(row.outstanding, row.currency)}</TD>
                      <TD>
                        <Badge
                          tone={row.status === 'Paid' ? 'success' : row.status === 'Part paid' ? 'warning' : 'neutral'}
                        >
                          {row.status}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={4}>Total, in USD</TD>
                    <TD numeric>{formatQuantityKg(bought)}</TD>
                    <TD numeric>{formatQuantityKg(landed)}</TD>
                    <TD colSpan={2} />
                    <TD numeric>{formatMoney(totalUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(owedUsd, 'USD')}</TD>
                    <TD />
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
