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
  if (transfer.workflowState !== 'DRAFT') redirect(`/inventory/transfers/${id}`);

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

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit ${label}`}
        description="A draft moves nothing yet, so it can be changed freely."
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
