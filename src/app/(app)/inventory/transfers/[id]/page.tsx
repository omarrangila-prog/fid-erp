import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getStockTransferDetail, TRANSFER_STATE_META, type TransferState } from '@/lib/services/stock-transfer';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { transferNumberLabel } from '@/lib/transfer-number';
import { formatBags, bagsForKg } from '@/lib/bags';
import { formatDate, formatQuantityKg, formatDateTime } from '@/lib/format';
import { dec } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/constants';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { NotFoundError } from '@/lib/errors';
import { TransferActions } from '@/app/(app)/inventory/transfers/[id]/transfer-actions';

export const metadata: Metadata = { title: 'Warehouse Transfer' };
export const dynamic = 'force-dynamic';

const TONES: Record<string, BadgeTone> = { DRAFT: 'neutral', APPROVED: 'info', IN_TRANSIT: 'progress', RECEIVED: 'success', CANCELLED: 'danger' };

/**
 * One warehouse transfer: where the coffee went, and for every line where it
 * came from in the first place — the ICUL/FID order, the batch, the lot and
 * the container — so the trail from purchase to sale never breaks.
 */
export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const transfer = await getStockTransferDetail(user.activeCompany.id, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const ordinals = await getShipmentOrdinals(user.activeCompany.id);
  const label = transferNumberLabel(transfer.transferNumber);
  const state = transfer.workflowState as TransferState;
  const reversed = transfer.status === 'REVERSED';
  const stateLabel = reversed ? 'Reversed' : (TRANSFER_STATE_META[state]?.label ?? state);
  const totalKg = transfer.lines.reduce((sum, l) => sum.plus(dec(l.quantityKg)), dec(0));
  const references = [...new Set(transfer.lines.map((l) => l.batch.purchaseContract?.contractReference).filter(Boolean))];

  const field = (name: string, value: React.ReactNode) => (
    <div>
      <p className="text-xs text-ink-muted">{name}</p>
      <p className="text-sm font-medium text-ink">{value}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={label}
        description={`${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name} · ${formatDate(transfer.transferDate)}`}
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Transfers', href: '/inventory/transfers' }, { label }]}
        meta={<Badge tone={reversed ? 'danger' : (TONES[state] ?? 'neutral')}>{stateLabel}</Badge>}
        actions={<TransferActions id={transfer.id} label={label} state={reversed ? 'CANCELLED' : state} canManage={can(user, PERMISSIONS.INVENTORY_TRANSFER)} />}
      />

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          {field('Transfer No.', label)}
          {field('Date', formatDate(transfer.transferDate))}
          {field('From warehouse', transfer.fromWarehouse.name)}
          {field('To warehouse', transfer.toWarehouse.name)}
          {field('ICUL/FID reference', references.length === 0 ? '—' : references.join(', '))}
          {field('Quantity', formatQuantityKg(totalKg))}
          {field('Status', stateLabel)}
          {field('Created by', `${transfer.requestedBy?.name ?? '—'} · ${formatDateTime(transfer.createdAt)}`)}
          {transfer.approvedBy ? field('Approved by', transfer.approvedBy.name) : null}
          {transfer.receivedBy ? field('Received by', transfer.receivedBy.name) : null}
          {transfer.notes ? <div className="sm:col-span-2 lg:col-span-4">{field('Notes', <span className="whitespace-pre-line font-normal">{transfer.notes}</span>)}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What moved</CardTitle>
          <CardDescription>Each line with the order it was bought on, so the stock can be followed from purchase to sale.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>ICUL/FID reference</TH>
                  <TH>Item</TH>
                  <TH>Batch</TH>
                  <TH>Lot</TH>
                  <TH>Container</TH>
                  <TH numeric>Quantity</TH>
                  <TH numeric>Bags</TH>
                </TR>
              </THead>
              <TBody>
                {transfer.lines.map((line) => (
                  <TR key={line.id}>
                    <TD>
                      {line.batch.purchaseContract ? (
                        <Link href={`/purchases/${line.batch.purchaseContract.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {line.batch.purchaseContract.contractReference}
                        </Link>
                      ) : (
                        '—'
                      )}
                      <span className="block text-xs text-ink-subtle">{shipmentOrdinalLabel(ordinals.get(line.batch.shipmentId))}</span>
                    </TD>
                    <TD>{line.item.itemName}</TD>
                    <TD>
                      <Link href={`/inventory/batches/${line.batch.id}`} className="text-forest-800 hover:text-gold-700">
                        {line.batch.batchNumber}
                      </Link>
                    </TD>
                    <TD>{line.batch.lot?.lotNumber ?? '—'}</TD>
                    <TD>{line.container?.containerNumber ?? '—'}</TD>
                    <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                    <TD numeric>{formatBags(line.bags || bagsForKg(line.quantityKg, line.batch.bagWeightKg))}</TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={5}>Total</TD>
                  <TD numeric>{formatQuantityKg(totalKg)}</TD>
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
