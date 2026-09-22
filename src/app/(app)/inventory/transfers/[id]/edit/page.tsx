import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getSellableStock } from '@/lib/services/stock';
import { getStockTransferDetail } from '@/lib/services/stock-transfer';
import { transferNumberLabel } from '@/lib/transfer-number';
import { toDateInputValue } from '@/lib/format';
import { NotFoundError } from '@/lib/errors';
import { dec } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { TransferForm, type TransferStock } from '@/app/(app)/inventory/transfers/new/transfer-form';

export const metadata: Metadata = { title: 'Edit Warehouse Transfer' };
export const dynamic = 'force-dynamic';

/** A draft is edited in place; anything further along is corrected from its own page. */
export default async function EditTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_TRANSFER);
  const companyId = user.activeCompany.id;
  const transfer = await getStockTransferDetail(companyId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  // A received or cancelled transfer is not edited in place: its page offers
  // Edit, which moves the stock back and opens a copy.
  if (!['DRAFT', 'APPROVED', 'IN_TRANSIT'].includes(transfer.workflowState)) redirect(`/inventory/transfers/${id}`);

  const [warehouses, stock] = await Promise.all([
    prisma.warehouse.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    getSellableStock(companyId),
  ]);
  const label = transferNumberLabel(transfer.transferNumber);
  const transferStock: TransferStock[] = stock.map((s) => ({
    batchId: s.batchId,
    warehouseId: s.warehouseId,
    batchNumber: s.batchNumber,
    lotNumber: s.lotNumber,
    itemName: s.itemName,
    availableKg: s.availableKg.toString(),
  }));

  // An approved transfer's own lines are reserved, so they no longer count as
  // free. Add each line's quantity back so the figure already entered still
  // validates, and a batch reserved in full is still on the list.
  if (transfer.workflowState !== 'DRAFT') {
    for (const line of transfer.lines) {
      const own = transferStock.find((s) => s.batchId === line.batch.id && s.warehouseId === transfer.fromWarehouseId);
      if (own) {
        own.availableKg = dec(own.availableKg).plus(dec(line.quantityKg)).toString();
      } else {
        transferStock.push({
          batchId: line.batch.id,
          warehouseId: transfer.fromWarehouseId,
          batchNumber: line.batch.batchNumber,
          lotNumber: line.batch.lot?.lotNumber ?? '—',
          itemName: line.item.itemName,
          availableKg: dec(line.quantityKg).toString(),
        });
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit ${label}`}
        description={
          transfer.workflowState === 'DRAFT'
            ? 'A draft moves nothing yet, so it can be changed freely.'
            : 'This transfer has reserved its stock at the source. Saving releases that reservation and takes it again for the lines you save; the transfer keeps its stage.'
        }
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Transfers', href: '/inventory/transfers' },
          { label, href: `/inventory/transfers/${id}` },
          { label: 'Edit' },
        ]}
      />
      <TransferForm
        warehouses={warehouses}
        stock={transferStock}
        nextNumber={label}
        defaults={{
          id: transfer.id,
          transferDate: toDateInputValue(transfer.transferDate),
          fromWarehouseId: transfer.fromWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          notes: transfer.notes ?? '',
          lines: transfer.lines.map((l) => ({ batchId: l.batchId, quantityKg: l.quantityKg.toString() })),
        }}
      />
    </div>
  );
}
