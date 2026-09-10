import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getStockAgeing, STOCK_AGEING_BUCKETS } from '@/lib/services/stock';
import { Decimal, toMoney, toQuantity } from '@/lib/money';
import { formatMoney, formatQuantityKg, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Badge } from '@/components/ui/badge';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import type { BadgeTone } from '@/lib/constants';

export const metadata: Metadata = { title: 'Stock Ageing' };
export const dynamic = 'force-dynamic';

/** Older coffee is a bigger problem, and the colour should say so. */
const BUCKET_TONES: Record<string, BadgeTone> = {
  '0–30 days': 'success',
  '31–60 days': 'info',
  '61–90 days': 'progress',
  '91–180 days': 'warning',
  'Over 180 days': 'danger',
  'Not yet received': 'neutral',
};

export default async function StockAgeingPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const rows = await getStockAgeing(user.activeCompany.id);

  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Stock Ageing"
          breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Stock Ageing' }]}
        />
        <EmptyState
          title="Nothing in a warehouse yet"
          description="Receive a purchase contract and every parcel appears here with how long it has been sitting."
        />
      </div>
    );
  }

  const summary = STOCK_AGEING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row) => row.bucket === bucket);
    return {
      bucket,
      parcels: inBucket.length,
      kg: toQuantity(inBucket.reduce((sum, row) => sum.plus(row.onHandKg), new Decimal(0))),
      value: toMoney(inBucket.reduce((sum, row) => sum.plus(row.valueUsd), new Decimal(0))),
    };
  });

  const totalKg = toQuantity(rows.reduce((sum, row) => sum.plus(row.onHandKg), new Decimal(0)));
  const totalValue = toMoney(rows.reduce((sum, row) => sum.plus(row.valueUsd), new Decimal(0)));
  const totalReserved = toQuantity(rows.reduce((sum, row) => sum.plus(row.reservedKg), new Decimal(0)));
  const oldest = rows.find((row) => row.daysInStock !== null);

  return (
    <div className="space-y-6">
      <PrintHeader
        title="Stock Ageing"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
        period={`${rows.length} parcels · ${formatQuantityKg(totalKg)} on hand`}
      />

      <PageHeader
        title="Stock Ageing"
        description="How long each parcel has been in the warehouse, oldest first."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Stock Ageing' }]}
        actions={<PrintButton />}
      />

      <Callout tone="info" title="Why this matters for coffee">
        Green coffee is not inert — it loses cup quality over months in a warehouse, and a buyer will notice before
        the books do. Age is counted from the day the parcel physically landed, not from the contract date, so coffee
        bought in January and delivered in April is four months younger than the contract suggests.{' '}
        <strong>Reserved</strong> is shown beside available, because a parcel that looks idle may already be promised.
      </Callout>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {summary.map((entry) => (
          <div key={entry.bucket} className="rounded-xl border border-line bg-surface p-4">
            <Badge tone={BUCKET_TONES[entry.bucket] ?? 'neutral'}>{entry.bucket}</Badge>
            <p className="mt-2 text-lg font-semibold tabular-nums text-ink">{formatQuantityKg(entry.kg)}</p>
            <p className="text-xs text-ink-subtle">
              {entry.parcels} parcel{entry.parcels === 1 ? '' : 's'}
              {showValue && entry.parcels > 0 ? ` · ${formatMoney(entry.value, 'USD')}` : ''}
            </p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Every parcel on hand</CardTitle>
          <CardDescription>
            {formatQuantityKg(totalKg)} across {rows.length} parcels
            {totalReserved.greaterThan(0) ? `, of which ${formatQuantityKg(totalReserved)} is reserved` : ''}
            {oldest?.daysInStock ? ` · oldest has been here ${oldest.daysInStock} days` : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap data-wide-sheet className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Batch</TH>
                  <TH>Coffee</TH>
                  <TH>Warehouse</TH>
                  <TH>Received</TH>
                  <TH numeric>Days</TH>
                  <TH numeric>On hand</TH>
                  <TH numeric>Reserved</TH>
                  <TH numeric>Available</TH>
                  {showValue ? <TH numeric>Value USD</TH> : null}
                  <TH>Age</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={`${row.batchId}-${row.warehouseName}`}>
                    <TD>
                      <Link href={`/inventory/batches/${row.batchId}`} className="font-medium text-forest-700 hover:underline">
                        {row.batchNumber}
                      </Link>
                      <span className="block text-xs text-ink-subtle">
                        Lot {row.lotNumber}
                        {row.containerNumber ? ` · ${row.containerNumber}` : ''}
                      </span>
                    </TD>
                    <TD>
                      <span className="block">{row.itemName}</span>
                      <span className="block text-xs text-ink-subtle">{row.originCountry}</span>
                    </TD>
                    <TD>{row.warehouseName}</TD>
                    <TD>{row.receivedAt ? formatDate(row.receivedAt) : '—'}</TD>
                    <TD numeric>{row.daysInStock ?? '—'}</TD>
                    <TD numeric>{formatQuantityKg(row.onHandKg)}</TD>
                    <TD numeric>
                      {row.reservedKg.greaterThan(0) ? formatQuantityKg(row.reservedKg) : '—'}
                    </TD>
                    <TD numeric>{formatQuantityKg(row.availableKg)}</TD>
                    {showValue ? <TD numeric>{formatMoney(row.valueUsd, 'USD')}</TD> : null}
                    <TD>
                      <Badge tone={BUCKET_TONES[row.bucket] ?? 'neutral'}>{row.bucket}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR>
                  <TD>Total</TD>
                  <TD />
                  <TD />
                  <TD />
                  <TD />
                  <TD numeric>{formatQuantityKg(totalKg)}</TD>
                  <TD numeric>{formatQuantityKg(totalReserved)}</TD>
                  <TD numeric>{formatQuantityKg(toQuantity(totalKg.minus(totalReserved)))}</TD>
                  {showValue ? <TD numeric>{formatMoney(totalValue, 'USD')}</TD> : null}
                  <TD />
                </TR>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
