'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { SHIPMENT_STATUS_META } from '@/lib/constants';
import { formatQuantityKg, todayInputValue } from '@/lib/format';
import { markOrderArrivedAction } from '@/server/actions/trading-actions';

export type OrderShipmentRow = {
  shipmentId: string;
  ordinal: number;
  status: string;
  arrived: boolean;
  received: boolean;
  itemName: string;
  containerNumber: string | null;
  lotNumber: string | null;
  batchNumber: string | null;
  batchId: string | null;
  warehouseName: string | null;
  orderedKg: string;
  receivedKg: string;
  availableKg: string;
  purchaseUsd: string;
  etaDate: string | null;
  ataDate: string | null;
};

export type OrderSummary = {
  reference: string;
  totalShipments: number;
  arrivedCount: number;
  receivedCount: number;
  containerCount: number;
  totalKg: string;
  receivedKg: string;
  remainingKg: string;
  totalPurchaseUsd: string;
  arrival: 'NOT_ARRIVED' | 'PARTIALLY_ARRIVED' | 'FULLY_ARRIVED';
  receipt: 'NOT_RECEIVED' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';
};

const ARRIVAL_LABEL = {
  NOT_ARRIVED: 'Not arrived',
  PARTIALLY_ARRIVED: 'Partially arrived',
  FULLY_ARRIVED: 'Fully arrived',
} as const;

const RECEIPT_LABEL = {
  NOT_RECEIVED: 'Not received',
  PARTIALLY_RECEIVED: 'Partially received',
  FULLY_RECEIVED: 'Fully received',
} as const;

/**
 * Every shipment on the order, on the order.
 *
 * The client opens ICUL/FID/001 and wants to know, without opening anything
 * else: how many shipments, which container carries which coffee, which lot
 * and batch it became, how much, what it cost, whether it has arrived and
 * where it went. So that is the table. The totals underneath are the lines
 * added up — three containers of 20,000 KG are 60,000, never 180,000.
 *
 * "Mark all arrived" is for the day the whole order lands together. The
 * individual controls stay on each shipment, because they usually do not.
 */
export function OrderShipments({
  contractId,
  summary,
  rows,
  canMarkArrived,
}: {
  contractId: string;
  summary: OrderSummary;
  rows: OrderShipmentRow[];
  canMarkArrived: boolean;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [ataDate, setAtaDate] = React.useState(todayInputValue());

  const pending = summary.totalShipments - summary.arrivedCount;

  async function markAll() {
    const result = await markOrderArrivedAction(contractId, ataDate);
    if (!result.ok) throw new Error(result.error);
    toast.success(
      result.data.marked === 0
        ? 'Every shipment on this order had already arrived.'
        : `${result.data.marked} of ${result.data.total} shipments marked arrived.`,
    );
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>
            {summary.totalShipments} {summary.totalShipments === 1 ? 'shipment' : 'shipments'} on this order
          </CardTitle>
          <CardDescription>
            {summary.arrivedCount} of {summary.totalShipments} arrived · {summary.receivedCount} of{' '}
            {summary.totalShipments} received · {summary.containerCount}{' '}
            {summary.containerCount === 1 ? 'container' : 'containers'} · {summary.totalKg}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={summary.arrival === 'FULLY_ARRIVED' ? 'success' : summary.arrival === 'PARTIALLY_ARRIVED' ? 'warning' : 'neutral'}>
            {ARRIVAL_LABEL[summary.arrival]}
          </Badge>
          <Badge tone={summary.receipt === 'FULLY_RECEIVED' ? 'success' : summary.receipt === 'PARTIALLY_RECEIVED' ? 'warning' : 'neutral'}>
            {RECEIPT_LABEL[summary.receipt]}
          </Badge>
          {canMarkArrived && pending > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
              <PackageCheck />
              Mark all arrived
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        <TableWrap className="rounded-none border-0 border-t">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Shipment</TH>
                <TH>Container</TH>
                <TH>Item</TH>
                <TH>Lot</TH>
                <TH>Batch</TH>
                <TH numeric>KG</TH>
                <TH numeric>Received</TH>
                <TH numeric>Purchase USD</TH>
                <TH>ETA</TH>
                <TH>Status</TH>
                <TH>Warehouse</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.shipmentId}>
                  <TD>
                    <Link href={`/shipments/${row.shipmentId}`} className="font-medium text-forest-800 hover:text-gold-700">
                      Shipment {row.ordinal}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs">{row.containerNumber ?? '—'}</TD>
                  <TD>{row.itemName}</TD>
                  <TD className="font-mono text-xs">{row.lotNumber ?? '—'}</TD>
                  <TD>
                    {row.batchId ? (
                      <Link href={`/inventory/batches/${row.batchId}`} className="text-forest-800 hover:text-gold-700">
                        {row.batchNumber}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD numeric>{row.orderedKg}</TD>
                  <TD numeric className={row.received ? 'text-forest-800' : 'text-ink-muted'}>{row.receivedKg}</TD>
                  <TD numeric>{row.purchaseUsd}</TD>
                  <TD className="text-xs">{row.ataDate ?? row.etaDate ?? '—'}</TD>
                  <TD>
                    <Badge tone={row.arrived ? 'success' : 'neutral'}>
                      {SHIPMENT_STATUS_META[row.status]?.label ?? row.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs text-ink-muted">{row.warehouseName ?? 'Not yet landed'}</TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <tr>
                <TD colSpan={5}>Whole order</TD>
                <TD numeric>{summary.totalKg}</TD>
                <TD numeric>{summary.receivedKg}</TD>
                <TD numeric>{summary.totalPurchaseUsd}</TD>
                <TD colSpan={3} className="text-xs text-ink-muted">
                  {summary.remainingKg === formatQuantityKg(0) ? 'Everything landed' : `${summary.remainingKg} still to come`}
                </TD>
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Mark all ${pending} ${pending === 1 ? 'shipment' : 'shipments'} under ${summary.reference} as arrived?`}
        description="Each shipment is moved to Arrived with its own history line. Shipments that already arrived are left as they are."
        confirmLabel="Mark all arrived"
        onConfirm={markAll}
        body={
          <Field label="Arrival date" htmlFor="orderAta" required>
            <Input id="orderAta" type="date" value={ataDate} onChange={(e) => setAtaDate(e.target.value)} />
          </Field>
        }
      />
    </Card>
  );
}
