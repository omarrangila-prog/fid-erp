import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatDate, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { EmptyAction } from '@/components/shared/empty-action';
import { GoodsReceiptsClient, type GoodsReceiptRow } from '@/app/(app)/goods-receipts/goods-receipts-client';

export const metadata: Metadata = { title: 'Goods Receipts' };
export const dynamic = 'force-dynamic';

export default async function GoodsReceiptsPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const companyId = user.activeCompany.id;

  const receipts = await prisma.goodsReceipt.findMany({
    where: { companyId },
    orderBy: [{ receiptDate: 'desc' }, { grnNumber: 'desc' }],
    include: {
      purchaseContract: { select: { id: true, contractNumber: true, contractReference: true } },
      vendor: { select: { vendorName: true } },
      warehouse: { select: { name: true, code: true } },
      receivedBy: { select: { name: true } },
      lines: { select: { quantityKg: true, bags: true, item: { select: { itemName: true } } } },
    },
  });

  const rows: GoodsReceiptRow[] = receipts.map((r) => {
    const quantityKg = r.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0));
    return {
      id: r.id,
      grnNumber: r.grnNumber,
      receiptDate: formatDate(r.receiptDate),
      receiptDateSort: r.receiptDate.getTime(),
      contractId: r.purchaseContract.id,
      contractNumber: r.purchaseContract.contractNumber,
      contractReference: r.purchaseContract.contractReference,
      vendorName: r.vendor.vendorName,
      warehouseName: r.warehouse.name,
      warehouseCode: r.warehouse.code,
      itemNames: [...new Set(r.lines.map((l) => l.item.itemName))].join(', '),
      quantityLabel: formatQuantityKg(quantityKg),
      quantityKg: Number(quantityKg),
      bags: r.lines.reduce((a, l) => a + l.bags, 0),
      lineCount: r.lines.length,
      receivedBy: r.receivedBy.name,
      status: r.status,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goods Receipts"
        description="Coffee becomes sellable stock only when it is received into a named warehouse."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Goods Receipts' }]}
      />

      <Callout tone="info" title="Receipts are raised from the contract">
        Open an approved{' '}
        <Link href="/purchases" className="font-medium underline underline-offset-2">
          purchase contract
        </Link>{' '}
        and use <strong>Receive goods</strong>. A contract can be received in as many partial receipts as the
        containers actually arrive in.
      </Callout>

      <GoodsReceiptsClient
        rows={rows}
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Open purchase contracts" tone="go" />
          ) : undefined
        }
      />
    </div>
  );
}
