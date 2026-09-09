import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getSellableStock } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { TransferForm, type TransferStock } from '@/app/(app)/inventory/transfers/new/transfer-form';

export const metadata: Metadata = { title: 'New Warehouse Transfer' };
export const dynamic = 'force-dynamic';

export default async function NewTransferPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_TRANSFER);
  const companyId = user.activeCompany.id;

  const [warehouses, stock] = await Promise.all([
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    getSellableStock(companyId),
  ]);

  const prerequisites: Prerequisite[] = [
    {
      met: warehouses.length > 1,
      label: 'Two or more warehouses',
      description: 'A transfer moves coffee from one warehouse to another, so there has to be somewhere to move it to.',
      href: '/warehouses',
      actionLabel: 'Open warehouses',
    },
    {
      met: stock.length > 0,
      label: 'Stock on hand',
      description: 'There is nothing in any warehouse yet. Receive a purchase contract first.',
      href: '/purchases',
      actionLabel: 'Open purchases',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Warehouse Transfer"
          breadcrumbs={[
            { label: 'Inventory', href: '/inventory' },
            { label: 'Transfers', href: '/inventory/transfers' },
            { label: 'New' },
          ]}
        />
        <PrerequisiteGate
          title="Before you can transfer stock"
          description="A transfer relocates coffee you already hold; it never creates any."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

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
        title="New Warehouse Transfer"
        description="Relocate coffee without changing how much the company owns."
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Transfers', href: '/inventory/transfers' },
          { label: 'New' },
        ]}
      />
      <TransferForm warehouses={warehouses} stock={transferStock} />
    </div>
  );
}
