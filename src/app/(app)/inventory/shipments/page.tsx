import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { getShipmentStock } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { dec } from '@/lib/money';

export const metadata: Metadata = { title: 'Shipment Stock' };
export const dynamic = 'force-dynamic';

export default async function ShipmentStockPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const rows = await getShipmentStock(user.activeCompany.id);

  const totals = rows.reduce(
    (acc, r) => ({
      received: acc.received.plus(r.receivedKg),
      sold: acc.sold.plus(r.soldKg),
      available: acc.available.plus(r.availableKg),
      value: acc.value.plus(r.stockValueUsd),
    }),
    { received: dec(0), sold: dec(0), available: dec(0), value: dec(0) },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipment Stock"
        description="What each job brought in, what has sold from it and what is left."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Shipment Stock' }]}
      />

      {rows.length === 0 ? (
        <EmptyState title="No shipment stock" description="Approve and receive a purchase contract to see stock here." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Shipment</TH>
                <TH>Coffee</TH>
                <TH>Supplier</TH>
                <TH>Buyer</TH>
                <TH>ETA</TH>
                <TH numeric>Received</TH>
                <TH numeric>Reserved</TH>
                <TH numeric>Sold</TH>
                <TH numeric>Available</TH>
                {showValue ? <TH numeric>Value</TH> : null}
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.shipmentId}>
                  <TD>
                    <Link href={`/shipments/${r.shipmentId}`} className="font-medium text-forest-800 hover:text-gold-700">
                      {r.shipmentNumber}
                    </Link>
                  </TD>
                  <TD>{r.itemName}</TD>
                  <TD>{r.vendorName}</TD>
                  <TD>{r.customerName ?? <span className="text-ink-subtle">Unsold</span>}</TD>
                  <TD>{formatDate(r.etaDate)}</TD>
                  <TD numeric>{formatQuantityKg(r.receivedKg)}</TD>
                  <TD numeric>{formatQuantityKg(r.allocatedKg)}</TD>
                  <TD numeric>{formatQuantityKg(r.soldKg)}</TD>
                  <TD numeric className="font-medium">{formatQuantityKg(r.availableKg)}</TD>
                  {showValue ? <TD numeric>{formatMoney(r.stockValueUsd, 'USD')}</TD> : null}
                  <TD>
                    <StatusBadge status={r.status} meta={SHIPMENT_STATUS_META} />
                  </TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <tr>
                <TD colSpan={5}>Total</TD>
                <TD numeric>{formatQuantityKg(totals.received)}</TD>
                <TD />
                <TD numeric>{formatQuantityKg(totals.sold)}</TD>
                <TD numeric>{formatQuantityKg(totals.available)}</TD>
                {showValue ? <TD numeric>{formatMoney(totals.value, 'USD')}</TD> : null}
                <TD />
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
