'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PackageCheck, Anchor, Eye, Calculator } from 'lucide-react';
import { RowActions } from '@/components/shared/row-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { CONTAINER_STAGE_META, type ContainerStage } from '@/lib/container-stage';
import { formatQuantityKg, todayInputValue } from '@/lib/format';
import { markOrderArrivedAction, markContainerArrivedAction } from '@/server/actions/trading-actions';

/** Fired by a row's "Receive goods"; the toolbar that owns the receipt sheet listens. */
export const RECEIVE_GOODS_EVENT = 'fid:receive-goods';

export type OrderShipmentRow = {
  shipmentId: string;
  ordinal: number;
  batchOrdinal: number;
  batchesOnShipment: number;
  status: string;
  stage: ContainerStage;
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
  arrivedContainers: number;
  receivedContainers: number;
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
 * Every container on the order, on the order.
 *
 * The client opens ICUL/FID/001 and wants to know, without opening anything
 * else: how many containers, which one carries which coffee, which lot and
 * batch it became, how much, what it cost, and whether it is pending loading,
 * loaded, arrived or received — each on its own, because one container
 * landing says nothing about the other four. So that is the table. The
 * totals underneath are the rows added up — three containers of 20,000 KG
 * are 60,000, never 180,000.
 *
 * "Mark all arrived" is for the day the whole order lands together. The
 * individual controls stay on each shipment, because they usually do not.
 */
export function OrderShipments({
  contractId,
  summary,
  rows,
  canMarkArrived,
  canReceive = false,
}: {
  contractId: string;
  summary: OrderSummary;
  rows: OrderShipmentRow[];
  canMarkArrived: boolean;
  canReceive?: boolean;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [ataDate, setAtaDate] = React.useState(todayInputValue());
  // One container arriving on its own: the row's own control, never the
  // order's, so nothing else is marked with it.
  const [arrivingRow, setArrivingRow] = React.useState<OrderShipmentRow | null>(null);
  const [rowAtaDate, setRowAtaDate] = React.useState(todayInputValue());

  async function markRowArrived() {
    if (!arrivingRow) return;
    const result = await markContainerArrivedAction(arrivingRow.shipmentId, rowAtaDate);
    if (!result || !result.ok) throw new Error(result?.error ?? 'The shipment could not be marked arrived.');
    toast.success(`Shipment ${arrivingRow.ordinal} marked arrived. It can be received now.`);
    router.refresh();
  }

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
            {summary.containerCount} {summary.containerCount === 1 ? 'container' : 'containers'} on this order
          </CardTitle>
          <CardDescription>
            {summary.arrivedContainers} of {summary.containerCount} containers arrived ·{' '}
            {summary.receivedContainers} of {summary.containerCount} received
            {summary.totalShipments !== summary.containerCount
              ? ` · ${summary.totalShipments} ${summary.totalShipments === 1 ? 'shipment' : 'shipments'}`
              : ''}{' '}
            · {summary.totalKg}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={summary.arrival === 'FULLY_ARRIVED' ? 'success' : summary.arrival === 'PARTIALLY_ARRIVED' ? 'warning' : 'neutral'}>
            {ARRIVAL_LABEL[summary.arrival]}
          </Badge>
          <Badge tone={summary.receipt === 'FULLY_RECEIVED' ? 'success' : summary.receipt === 'PARTIALLY_RECEIVED' ? 'warning' : 'neutral'}>
            {RECEIPT_LABEL[summary.receipt]}
          </Badge>
          {canMarkArrived ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={pending === 0}
              title={pending === 0 ? 'Every shipment on this order has already arrived.' : undefined}
            >
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
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.batchId ?? `${row.shipmentId}-${row.batchOrdinal}`}>
                  <TD>
                    <Link href={`/shipments/${row.shipmentId}`} className="font-medium text-forest-800 hover:text-gold-700">
                      Shipment {row.ordinal}
                    </Link>
                    {row.batchesOnShipment > 1 ? (
                      <span className="block text-[11px] text-ink-subtle">
                        batch {row.batchOrdinal} of {row.batchesOnShipment} on it
                      </span>
                    ) : null}
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
                    <Badge tone={CONTAINER_STAGE_META[row.stage].tone}>{CONTAINER_STAGE_META[row.stage].label}</Badge>
                  </TD>
                  <TD className="text-xs text-ink-muted">{row.warehouseName ?? 'Not yet landed'}</TD>
                  <TD>
                    <RowActions
                      inline={2}
                      actions={[
                        {
                          label: 'Mark arrived',
                          icon: Anchor,
                          show: canMarkArrived && !row.arrived,
                          onSelect: () => {
                            setRowAtaDate(todayInputValue());
                            setArrivingRow(row);
                          },
                        },
                        {
                          label: 'Receive goods',
                          icon: PackageCheck,
                          show: canReceive && row.arrived && !row.received,
                          onSelect: () => window.dispatchEvent(new CustomEvent(RECEIVE_GOODS_EVENT)),
                        },
                        { label: 'View', icon: Eye, href: `/shipments/${row.shipmentId}` },
                        { label: 'Costing', icon: Calculator, href: `/reports/shipment-cost?shipment=${row.shipmentId}` },
                      ]}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <tr>
                <TD colSpan={5}>Whole order</TD>
                <TD numeric>{summary.totalKg}</TD>
                <TD numeric>{summary.receivedKg}</TD>
                <TD numeric>{summary.totalPurchaseUsd}</TD>
                <TD colSpan={4} className="text-xs text-ink-muted">
                  {summary.remainingKg === formatQuantityKg(0) ? 'Everything landed' : `${summary.remainingKg} still to come`}
                </TD>
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      </CardContent>

      <ConfirmDialog
        open={arrivingRow !== null}
        onOpenChange={(open) => {
          if (!open) setArrivingRow(null);
        }}
        title={arrivingRow ? `Mark shipment ${arrivingRow.ordinal}${arrivingRow.containerNumber ? ` (${arrivingRow.containerNumber})` : ''} as arrived?` : ''}
        description="Only this one. The other containers on the order keep their own status."
        confirmLabel="Mark arrived"
        onConfirm={markRowArrived}
        body={
          <Field label="Arrival date" htmlFor="rowAta" required>
            <Input id="rowAta" type="date" value={rowAtaDate} onChange={(e) => setRowAtaDate(e.target.value)} />
          </Field>
        }
      />

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
