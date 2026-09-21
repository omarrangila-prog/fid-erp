import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { transferNumberLabel, parseTransferSequence } from '@/lib/transfer-number';
import { dec } from '@/lib/money';
import { formatQuantityKg, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { TransfersClient, type TransferRow } from '@/app/(app)/inventory/transfers/transfers-client';

export const metadata: Metadata = { title: 'Warehouse Transfers' };
export const dynamic = 'force-dynamic';

export default async function TransfersPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);

  const transfers = await prisma.stockTransfer.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ transferDate: 'desc' }, { transferNumber: 'desc' }],
    include: {
      fromWarehouse: { select: { name: true } },
      toWarehouse: { select: { name: true } },
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        select: {
          quantityKg: true,
          item: { select: { itemName: true } },
          container: { select: { containerNumber: true } },
          batch: {
            select: {
              id: true,
              batchNumber: true,
              lot: { select: { lotNumber: true } },
              purchaseContract: { select: { contractReference: true } },
            },
          },
        },
      },
    },
  });

  const rows: TransferRow[] = transfers.map((t) => {
    const quantity = t.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0));
    return {
      id: t.id,
      // WTO-004, whichever form the record was stored in (src/lib/transfer-number.ts).
      transferLabel: transferNumberLabel(t.transferNumber),
      transferSequence: parseTransferSequence(t.transferNumber) ?? 0,
      storedNumber: t.transferNumber,
      transferDate: formatDate(t.transferDate),
      transferDateSort: t.transferDate.getTime(),
      fromWarehouse: t.fromWarehouse.name,
      toWarehouse: t.toWarehouse.name,
      lineCount: t.lines.length,
      quantityLabel: formatQuantityKg(quantity),
      quantitySort: Number(quantity),
      state: t.status === 'REVERSED' ? 'REVERSED' : t.workflowState,
      stateLabel: t.status === 'REVERSED' ? 'Reversed' : titleCase(t.workflowState),
      // The stock's origin on every line, derived from the batch — never typed.
      lines: t.lines.map((l) => ({
        reference: l.batch.purchaseContract?.contractReference ?? '—',
        itemName: l.item.itemName,
        batchId: l.batch.id,
        batchNumber: l.batch.batchNumber,
        lotNumber: l.batch.lot?.lotNumber ?? '—',
        containerNumber: l.container?.containerNumber ?? '—',
        quantityLabel: formatQuantityKg(l.quantityKg),
      })),
      requestedBy: t.requestedBy.name,
      approvedBy: t.approvedBy?.name ?? null,
      receivedBy: t.receivedBy?.name ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Warehouse Transfers"
        description="Move coffee between locations. Company stock never changes — only where it sits."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Transfers' }]}
      />

      <Callout tone="info" title="How a transfer moves stock">
        Approving <strong>reserves</strong> the quantity at the source so it cannot also be sold. Receiving posts the
        outbound and inbound movements together in one transaction, so the total the company owns is identical before
        and after — it can never be duplicated at both ends or go missing in between.
      </Callout>

      <TransfersClient rows={rows} canManage={can(user, PERMISSIONS.INVENTORY_TRANSFER)} />
    </div>
  );
}
