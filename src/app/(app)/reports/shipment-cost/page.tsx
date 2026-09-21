import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getShipmentExpensesByCategory } from '@/lib/services/profitability';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { dec } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { FavouriteStar } from '@/components/reports/report-statement';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Shipment Cost Report' };
export const dynamic = 'force-dynamic';

/**
 * What one shipment of coffee actually cost, line by line.
 *
 * The contract price is only part of it: freight, clearing, offloading,
 * storage and commission all land on the same coffee, and the number that
 * matters to a trader is what a kilo ended up costing once all of it is in.
 * That figure is shown in dollars and in the company's own currency, because
 * the coffee is bought in one and sold in the other.
 *
 * Every line here is a posted expense against this job. Nothing is estimated
 * and nothing is apportioned by guesswork — if a cost is not on this list, it
 * was not booked to this shipment.
 */
export default async function ShipmentCostPage({
  searchParams,
}: {
  searchParams: Promise<{ shipment?: string }>;
}) {
  const { shipment } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;

  const shipments = await prisma.shipment.findMany({
    where: { companyId },
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true,
      jobNumber: true,
      status: true,
      purchaseContract: { select: { contractReference: true, vendor: { select: { vendorName: true } } } },
    },
  });

  const selectedId = shipment && shipments.some((s) => s.id === shipment) ? shipment : shipments[0]?.id;
  const selected = shipments.find((s) => s.id === selectedId);
  const sheet = selectedId ? await getShipmentCostSheet(companyId, selectedId) : null;
  // The same costs summed by the category they were booked to, so freight,
  // clearing and transport each show as their own figure rather than one sum.
  const byCategory = selectedId
    ? ((await getShipmentExpensesByCategory({ companyId, shipmentId: selectedId })).get(selectedId) ?? [])
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipment Cost Report"
        description="What one job of coffee cost once freight, clearing and every other charge is in — per kilo, in both currencies."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Shipment Cost' }]}
        actions={
          <>
            <FavouriteStar href="/reports/shipment-cost" label="Shipment Cost Report" />
            {selectedId ? <ExportLinks href={exportHref('shipment-cost', { shipment: selectedId })} print={false} /> : null}
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Shipment Cost Report"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      {shipments.length === 0 ? (
        <EmptyState
          title="No shipments yet"
          description="A shipment is created when a purchase contract is posted. Its costs appear here as they are booked."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 print:hidden">
            {shipments.map((s) => (
              <Link
                key={s.id}
                href={`/reports/shipment-cost?shipment=${s.id}`}
                className={cn(
                  'rounded-xl border-2 px-3 py-2 text-sm transition-colors',
                  s.id === selectedId
                    ? 'border-forest-500 bg-forest-50/60 font-semibold text-ink'
                    : 'border-line bg-surface text-ink-muted hover:border-forest-300',
                )}
              >
                {s.jobNumber}
                <span className="ml-1.5 text-xs text-ink-subtle">
                  {s.purchaseContract?.vendor.vendorName ?? ''}
                </span>
              </Link>
            ))}
          </div>

          {sheet ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: 'Coffee', value: formatMoney(sheet.goodsUsd, 'USD'), sub: 'The contract price' },
                  {
                    label: 'Costs added',
                    value: formatMoney(sheet.expenseUsd, 'USD'),
                    sub: 'Freight, clearing, everything else',
                  },
                  {
                    label: 'Total landed cost',
                    value: formatMoney(sheet.totalShipmentCostUsd, 'USD'),
                    sub: formatMoney(sheet.totalShipmentCostLocal, sheet.localCurrency),
                  },
                  {
                    label: 'Cost per KG',
                    value: formatMoney(sheet.costPerKgUsd, 'USD'),
                    sub: `${formatMoney(sheet.costPerKgLocal, sheet.localCurrency)} per KG`,
                  },
                ].map((card) => (
                  <Card key={card.label} className={card.label === 'Cost per KG' ? 'border-forest-300 bg-forest-50/40' : undefined}>
                    <CardContent className="pt-5">
                      <p className="text-xs text-ink-muted">{card.label}</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{card.value}</p>
                      <p className="mt-0.5 text-[11px] text-ink-subtle">{card.sub}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {selected?.jobNumber} · {sheet.contractReference}
                  </CardTitle>
                  <CardDescription>
                    {formatQuantityKg(sheet.receivedKg)} landed of {formatQuantityKg(sheet.orderedKg)} bought ·{' '}
                    {formatQuantityKg(sheet.soldKg)} sold · {formatQuantityKg(sheet.remainingKg)} still in stock.
                    Rate used for {sheet.localCurrency}: {dec(sheet.rateLocalPerUsd).toString()} per USD.
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <TableWrap className="rounded-none border-0 border-t">
                    <Table>
                      <THead>
                        <TR className="hover:bg-transparent">
                          <TH>Date</TH>
                          <TH>Cost</TH>
                          <TH>Description</TH>
                          <TH>Container</TH>
                          <TH numeric>Amount</TH>
                          <TH numeric>USD</TH>
                          <TH numeric>{sheet.localCurrency}</TH>
                          <TH>In the coffee?</TH>
                          <TH>Paid</TH>
                        </TR>
                      </THead>
                      <TBody>
                        <TR className="bg-forest-50/40 hover:bg-forest-50/40">
                          <TD colSpan={4} className="text-xs font-medium text-ink-muted">
                            Coffee, at the contract price
                          </TD>
                          <TD />
                          <TD numeric className="font-semibold">{formatMoney(sheet.goodsUsd, 'USD')}</TD>
                          <TD numeric className="font-semibold">{formatMoney(sheet.goodsLocal, sheet.localCurrency)}</TD>
                          <TD colSpan={2} />
                        </TR>
                        {sheet.lines.length === 0 ? (
                          <TR>
                            <TD colSpan={9} className="py-8 text-center text-xs text-ink-subtle">
                              No costs have been booked against this job yet.
                            </TD>
                          </TR>
                        ) : (
                          sheet.lines.map((line) => (
                            <TR key={line.expenseId}>
                              <TD>{formatDate(line.expenseDate)}</TD>
                              <TD>
                                <Link
                                  href={`/finance/expenses/${line.expenseId}`}
                                  className="font-medium text-forest-800 hover:text-gold-700"
                                >
                                  {line.category}
                                </Link>
                                <span className="block text-xs text-ink-subtle">{line.expenseNumber}</span>
                              </TD>
                              <TD className="text-xs text-ink-muted">{line.description ?? '—'}</TD>
                              <TD className="text-xs">{line.containerNumber ?? '—'}</TD>
                              <TD numeric>{formatMoney(line.amount, line.currency)}</TD>
                              <TD numeric>{formatMoney(line.amountUsd, 'USD')}</TD>
                              <TD numeric>{formatMoney(line.amountLocal, sheet.localCurrency)}</TD>
                              <TD>
                                <Badge tone={line.capitalised ? 'success' : 'neutral'}>
                                  {line.capitalised ? 'Yes' : 'No — a running cost'}
                                </Badge>
                              </TD>
                              <TD className="text-xs text-ink-muted">
                                {line.paid ? (line.paidFrom ?? 'Paid') : 'Owed'}
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                      <TBody>
                        {byCategory.length > 0 ? (
                          <>
                            <TR className="bg-surface-sunken/40 hover:bg-surface-sunken/40">
                              <TD colSpan={9} className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                                By category
                              </TD>
                            </TR>
                            {byCategory.map((row) => (
                              <TR key={`${row.category}-${row.capitalised}`}>
                                <TD />
                                <TD className="font-medium">{row.category}</TD>
                                <TD className="text-xs text-ink-muted">
                                  {row.count} {row.count === 1 ? 'entry' : 'entries'}
                                </TD>
                                <TD colSpan={2} />
                                <TD numeric>{formatMoney(row.amountUsd, 'USD')}</TD>
                                <TD numeric>{formatMoney(row.amountLocal, sheet.localCurrency)}</TD>
                                <TD>
                                  <Badge tone={row.capitalised ? 'success' : 'neutral'}>
                                    {row.capitalised ? 'Yes' : 'No — a running cost'}
                                  </Badge>
                                </TD>
                                <TD />
                              </TR>
                            ))}
                          </>
                        ) : null}
                      </TBody>
                      <TFoot>
                        <tr>
                          <TD colSpan={5}>Total landed cost</TD>
                          <TD numeric>{formatMoney(sheet.totalShipmentCostUsd, 'USD')}</TD>
                          <TD numeric>{formatMoney(sheet.totalShipmentCostLocal, sheet.localCurrency)}</TD>
                          <TD colSpan={2} />
                        </tr>
                      </TFoot>
                    </Table>
                  </TableWrap>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>What has been sold of it</CardTitle>
                  <CardDescription>
                    Profit is what the sales earned less the cost frozen on each line when the invoice was posted.
                    The coffee still in stock is not counted either way until it sells.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-xs text-ink-muted">Sold</p>
                    <p className="text-lg font-semibold tabular-nums text-ink">{formatQuantityKg(sheet.soldKg)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-muted">Revenue</p>
                    <p className="text-lg font-semibold tabular-nums text-ink">{formatMoney(sheet.revenueUsd, 'USD')}</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-muted">Cost of what sold</p>
                    <p className="text-lg font-semibold tabular-nums text-ink">{formatMoney(sheet.cogsUsd, 'USD')}</p>
                  </div>
                  <div>
                    <p className="text-xs text-ink-muted">Gross profit</p>
                    <p
                      className={cn(
                        'text-lg font-semibold tabular-nums',
                        dec(sheet.grossProfitUsd).greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600',
                      )}
                    >
                      {formatMoney(sheet.grossProfitUsd, 'USD')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-subtle">
                      {formatMoney(sheet.profitPerKgUsd, 'USD')} per KG · {dec(sheet.profitPct).toFixed(1)}%
                    </p>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
