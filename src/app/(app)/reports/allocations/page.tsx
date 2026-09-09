import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { formatQuantityKg, formatDate, formatMoney } from '@/lib/format';
import { toQuantity, Decimal } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { Badge } from '@/components/ui/badge';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, THead, TBody, TR, TH, TD, TFoot } from '@/components/ui/table';
import type { BadgeTone } from '@/lib/constants';

export const metadata: Metadata = { title: 'Stock Allocation' };
export const dynamic = 'force-dynamic';

const SETTLEMENT_TONES: Record<string, BadgeTone> = {
  PAID: 'success',
  PARTIAL: 'progress',
  UNPAID: 'warning',
  OVERDUE: 'danger',
};

/**
 * Where each purchase went.
 *
 * One purchase, many customers. This is the shape Morocco actually trades in:
 * a container arrives, and over the following weeks it is sold off in pieces.
 * The purchase stays one record — it is never overwritten with the name of the
 * last customer to take some — and this report shows the pieces underneath it.
 *
 * Every figure is derived. Sold is the sum of what was actually invoiced from
 * the batch; remaining is what the stock ledger says is left; the payment
 * position on each line comes from the receipts posted against that invoice.
 */
export default async function AllocationsPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const sheet = await getLoadingSheet(user.activeCompany.id);

  // Grouped by contract, because that is the thing the client bought.
  const contracts = new Map<string, { reference: string; number: string; date: Date; exporter: string; rows: typeof sheet }>();
  for (const row of sheet) {
    const entry = contracts.get(row.contractId) ?? {
      reference: row.contractReference,
      number: row.contractNumber,
      date: row.contractDate,
      exporter: row.exporter,
      rows: [] as typeof sheet,
    };
    entry.rows.push(row);
    contracts.set(row.contractId, entry);
  }

  const groups = [...contracts.entries()].sort((a, b) => b[1].date.getTime() - a[1].date.getTime());

  if (groups.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Stock Allocation" breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Allocation' }]} />
        <EmptyState
          title="Nothing purchased yet"
          description="Approve a purchase contract and it appears here, with whatever has been sold from it."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Allocation"
        description="Each purchase, and every customer it was sold to."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Allocation' }]}
        actions={<PrintButton />}
      />

      <Callout tone="info" title="One purchase, many customers">
        A container bought as one contract is often sold to several customers over several weeks. The purchase stays a
        single record; the sales sit underneath it. <strong>Sold</strong> is the sum of what was actually invoiced from
        each batch and <strong>remaining</strong> is what the stock ledger says is left — neither is a figure anyone
        types or maintains.
      </Callout>

      {groups.map(([contractId, group]) => {
        const purchased = group.rows.reduce((sum, row) => sum.plus(row.quantityKg), new Decimal(0));
        const sold = group.rows.reduce((sum, row) => sum.plus(row.soldKg), new Decimal(0));
        const reserved = group.rows.reduce((sum, row) => sum.plus(row.reservedKg), new Decimal(0));
        const available = group.rows.reduce((sum, row) => sum.plus(row.availableKg), new Decimal(0));
        const allocations = group.rows.flatMap((row) =>
          row.allocations.map((allocation) => ({ ...allocation, batchNumber: row.batchNumber })),
        );

        const state = sold.lessThanOrEqualTo('0.001')
          ? { label: 'Unsold', tone: 'neutral' as BadgeTone }
          : sold.greaterThanOrEqualTo(purchased.minus('0.001'))
            ? { label: 'Fully sold', tone: 'success' as BadgeTone }
            : { label: 'Partially sold', tone: 'progress' as BadgeTone };

        return (
          <Card key={contractId} className="break-inside-avoid">
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <Link href={`/purchases/${contractId}`} className="text-forest-800 hover:underline">
                    {group.reference}
                  </Link>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </CardTitle>
                <CardDescription>
                  {group.number} · {group.exporter} · {formatDate(group.date)}
                </CardDescription>
              </div>

              <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-ink-muted">Purchased</dt>
                  <dd className="tabular-nums font-semibold">{formatQuantityKg(toQuantity(purchased))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Sold</dt>
                  <dd className="tabular-nums font-semibold">{formatQuantityKg(toQuantity(sold))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Reserved</dt>
                  <dd className="tabular-nums">{formatQuantityKg(toQuantity(reserved))}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Available</dt>
                  <dd className="tabular-nums font-semibold text-forest-800">
                    {formatQuantityKg(toQuantity(available))}
                  </dd>
                </div>
              </dl>
            </CardHeader>

            <CardContent className="px-0 sm:px-0">
              {allocations.length === 0 ? (
                <p className="px-5 pb-4 text-sm text-ink-subtle">
                  Nothing sold from this contract yet — the whole {formatQuantityKg(toQuantity(available))} is still
                  available.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Customer</TH>
                        <TH>Invoice</TH>
                        <TH>From batch</TH>
                        <TH numeric>Quantity</TH>
                        <TH numeric>Value</TH>
                        <TH numeric>Outstanding</TH>
                        <TH>Payment</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {allocations.map((allocation) => (
                        <TR key={`${allocation.invoiceId}-${allocation.batchNumber}`}>
                          <TD>
                            <Link
                              href={`/customers/${allocation.customerId}`}
                              className="text-forest-700 hover:underline"
                            >
                              {allocation.customerName}
                            </Link>
                          </TD>
                          <TD>
                            <Link
                              href={`/sales/${allocation.invoiceId}`}
                              className="text-forest-700 hover:underline"
                            >
                              {allocation.invoiceNumber}
                            </Link>
                            <span className="block text-xs text-ink-subtle">
                              {formatDate(allocation.invoiceDate)}
                            </span>
                          </TD>
                          <TD>
                            <span className="font-mono text-xs">{allocation.batchNumber}</span>
                          </TD>
                          <TD numeric>{formatQuantityKg(allocation.quantityKg)}</TD>
                          <TD numeric>{formatMoney(allocation.amount, allocation.currency)}</TD>
                          <TD numeric>{formatMoney(allocation.outstanding, allocation.currency)}</TD>
                          <TD>
                            <Badge tone={SETTLEMENT_TONES[allocation.settlement] ?? 'neutral'}>
                              {allocation.settlement.toLowerCase()}
                            </Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                    <TFoot>
                      <TR>
                        <TD>Total sold</TD>
                        <TD />
                        <TD />
                        <TD numeric>{formatQuantityKg(toQuantity(sold))}</TD>
                        <TD />
                        <TD />
                        <TD />
                      </TR>
                      <TR>
                        <TD>Still available</TD>
                        <TD />
                        <TD />
                        <TD numeric>{formatQuantityKg(toQuantity(available))}</TD>
                        <TD />
                        <TD />
                        <TD />
                      </TR>
                    </TFoot>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
