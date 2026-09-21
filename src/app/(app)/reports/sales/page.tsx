import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getSalesRegister } from '@/lib/services/reports';
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
import { Input } from '@/components/ui/input';
import { shortDocumentNumber } from '@/lib/short-number';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Sales Report' };
export const dynamic = 'force-dynamic';

/**
 * Every sale in a period: who bought, how much coffee, what it earned and what
 * is still owed on it.
 *
 * Read from the posted invoices, because that is what the question is about —
 * documents, not ledger movements — and the money settled is what the receipts
 * and credit notes say. It agrees with the receivables report by construction:
 * both ask the same query what has been paid.
 */
export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; ref?: string }>;
}) {
  const { from, to, ref } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);

  const rows = await getSalesRegister({
    companyId: user.activeCompany.id,
    from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
    to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
    reference: ref,
  });

  const totalUsd = sum(rows.map((r) => dec(r.totalUsd)));
  const cogsUsd = sum(rows.map((r) => dec(r.costOfGoodsUsd)));
  const profitUsd = sum(rows.map((r) => dec(r.grossProfitUsd)));
  const owedUsd = sum(
    rows.map((r) =>
      dec(r.total).isZero() ? dec(0) : dec(r.outstanding).dividedBy(dec(r.total)).times(dec(r.totalUsd)),
    ),
  );
  const kg = sum(rows.map((r) => dec(r.quantityKg)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Report"
        description="Every sale in the period, what it cost, what it earned and what is still owed on it."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Sales' }]}
        actions={<ExportLinks href={exportHref('sales-register', { from, to, ref })} />}
      />
      <PrintHeader title="Sales Report" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="space-y-3 print:hidden">
        <DateRangePicker defaultFrom={from ?? ''} defaultTo={to ?? ''} />
        {/* A plain form, so the filter lives in the URL like the dates do. */}
        <form method="get" className="flex flex-wrap items-end gap-2">
          {from ? <input type="hidden" name="from" value={from} /> : null}
          {to ? <input type="hidden" name="to" value={to} /> : null}
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            ICUL/FID reference
            <Input name="ref" defaultValue={ref ?? ''} placeholder="e.g. ICUL/FID/002" className="w-56" />
          </label>
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
          {ref ? (
            <Link href={`/reports/sales?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`} className="text-sm text-forest-800 hover:text-gold-700">
              Show every reference
            </Link>
          ) : null}
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: 'Coffee sold', value: formatQuantityKg(kg), tone: 'text-ink' },
          { label: 'Revenue', value: formatMoney(totalUsd, 'USD'), tone: 'text-ink' },
          { label: 'Cost of goods', value: formatMoney(cogsUsd, 'USD'), tone: 'text-ink' },
          { label: 'Gross profit', value: formatMoney(profitUsd, 'USD'), tone: 'text-gold-700' },
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
          title="No sales in this period"
          description="Change the dates above, or raise an invoice and it will appear here."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{rows.length} {rows.length === 1 ? 'invoice' : 'invoices'}</CardTitle>
            <CardDescription>
              Each row opens the invoice it came from. Amounts are in the currency each was raised in; the totals
              above are stated in USD so they can be added together.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Invoice</TH>
                    <TH>Customer</TH>
                    <TH>ICUL/FID Ref</TH>
                    <TH numeric>KG</TH>
                    <TH numeric>Total</TH>
                    <TH numeric>Paid</TH>
                    <TH numeric>Outstanding</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.invoiceId}>
                      <TD>{formatDate(row.invoiceDate)}</TD>
                      <TD>
                        <Link
                          href={`/sales/${row.invoiceId}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {shortDocumentNumber(row.invoiceNumber)}
                        </Link>
                      </TD>
                      <TD>
                        <Link
                          href={`/ledgers/customers/${row.customerId}`}
                          className="text-forest-800 hover:text-gold-700"
                        >
                          {row.customerName}
                        </Link>
                      </TD>
                      <TD className="text-xs">
                        {row.references.length === 0
                          ? '—'
                          : row.references.length <= 2
                            ? row.references.join(', ')
                            : `Multiple references (${row.references.length})`}
                      </TD>
                      <TD numeric>{formatQuantityKg(row.quantityKg)}</TD>
                      <TD numeric>{formatMoney(row.total, row.currency)}</TD>
                      <TD numeric>{formatMoney(row.settled, row.currency)}</TD>
                      <TD numeric className="font-medium">
                        {formatMoney(row.outstanding, row.currency)}
                      </TD>
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
                    <TD numeric>{formatQuantityKg(kg)}</TD>
                    <TD numeric>{formatMoney(totalUsd, 'USD')}</TD>
                    <TD />
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
