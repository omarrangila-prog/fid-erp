import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, VISIBLE_DOCUMENT_STATUSES } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec, toQuantity } from '@/lib/money';
import { getPayables } from '@/lib/services/receivables';
import { getWarehouseLabels } from '@/lib/services/stock';
import { formatDate, formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PurchasesClient, type PurchaseRow } from '@/app/(app)/purchases/purchases-client';

export const metadata: Metadata = { title: 'Purchase Contracts' };
export const dynamic = 'force-dynamic';

export default async function PurchasesPage() {
  const user = await requirePageAccess(PERMISSIONS.PURCHASES_VIEW);
  const companyId = user.activeCompany.id;
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [contracts, payables, warehouses] = await Promise.all([
    prisma.purchaseContract.findMany({
      where: { companyId, status: { in: [...VISIBLE_DOCUMENT_STATUSES] } },
      orderBy: [{ contractDate: 'desc' }, { contractNumber: 'desc' }],
      include: {
        vendor: { select: { vendorName: true } },
        lines: { select: { quantityKg: true, bags: true, item: { select: { itemName: true } } } },
        shipments: { select: { id: true, jobNumber: true, status: true, etaDate: true } },
        batches: { select: { orderedQuantityKg: true, receivedQuantityKg: true } },
      },
    }),
    getPayables({ companyId }),
    getWarehouseLabels(companyId),
  ]);

  const payableByContract = new Map(payables.map((p) => [p.contractId, p]));

  const rows: PurchaseRow[] = contracts.map((c) => {
    const quantityKg = c.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0));
    const bags = c.lines.reduce((a, l) => a + l.bags, 0);
    const ordered = c.batches.reduce((a, b) => a.plus(dec(b.orderedQuantityKg)), dec(0));
    const received = c.batches.reduce((a, b) => a.plus(dec(b.receivedQuantityKg)), dec(0));
    const receivedPct = ordered.greaterThan(0) ? Number(received.dividedBy(ordered).times(100).toFixed(1)) : 0;
    const payable = payableByContract.get(c.id);
    const outstandingUsd = Number(payable?.outstandingAmountUsd ?? 0);

    const itemNames = [...new Set(c.lines.map((l) => l.item.itemName))].join(', ');

    return {
      id: c.id,
      contractNumber: c.contractNumber,
      contractReference: c.contractReference,
      supplierContractNo: c.supplierContractNo,
      contractDate: formatDate(c.contractDate),
      contractDateSort: c.contractDate.getTime(),
      vendorName: c.vendor.vendorName,
      origin: c.origin,
      itemNames: itemNames || '—',
      currency: c.currency,
      totalValueLabel: formatMoney(c.totalValue, c.currency),
      totalValueUsd: Number(c.totalValueUsd),
      quantityLabel: formatQuantityKg(toQuantity(quantityKg)),
      quantityKg: Number(quantityKg),
      bags,
      containers: c.containers,
      status: c.status,
      jobNumber: c.shipments[0]?.jobNumber ?? null,
      shipmentId: c.shipments[0]?.id ?? null,
      shipmentStatus: c.shipments[0]?.status ?? null,
      receivedPct,
      receivedLabel: c.status === 'POSTED' ? `${receivedPct}%` : '—',
      outstandingUsd,
      outstandingLabel: outstandingUsd > 0 ? formatMoney(outstandingUsd, 'USD') : '—',
      warehouseNames: warehouses.byContract.get(c.id) ?? '',
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Contracts"
        description="Approving a contract creates the supplier payable and opens a job. Coffee reaches a warehouse only through a goods receipt."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Purchase Contracts' }]}
      />
      <PurchasesClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.PURCHASES_CREATE)}
        canEdit={can(user, PERMISSIONS.PURCHASES_EDIT)}
        showCost={showCost}
      />
    </div>
  );
}
