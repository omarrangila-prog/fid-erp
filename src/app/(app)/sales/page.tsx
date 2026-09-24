import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, VISIBLE_DOCUMENT_STATUSES } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatMoney, formatQuantityKg, formatDate, daysUntil } from '@/lib/format';
import { getReceivables } from '@/lib/services/receivables';
import { getWarehouseLabels } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { SalesClient, type SaleRow } from '@/app/(app)/sales/sales-client';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

/** One reference, two named, or "Multiple references" — the header summary of the lines. */
function summariseReferences(refs: Array<string | null>): string | null {
  const distinct = [...new Set(refs.filter((r): r is string => Boolean(r)))];
  if (distinct.length === 0) return null;
  if (distinct.length <= 2) return distinct.join(', ');
  return `Multiple references (${distinct.length})`;
}

export default async function SalesPage() {
  const user = await requirePageAccess(PERMISSIONS.SALES_VIEW);
  const companyId = user.activeCompany.id;

  const [invoices, receivables, warehouses] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { companyId, status: { in: [...VISIBLE_DOCUMENT_STATUSES] } },
      orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
      include: {
        customer: { select: { id: true, customerName: true } },
        shipment: {
          select: {
            id: true,
            jobNumber: true,
            purchaseContract: { select: { contractReference: true } },
          },
        },
        createdBy: { select: { name: true } },
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: {
            quantityKg: true,
            item: { select: { itemName: true } },
            // The stock's origin, line by line: one invoice can sell from several orders.
            batch: { select: { batchNumber: true, purchaseContract: { select: { contractReference: true } } } },
            warehouse: { select: { name: true } },
          },
        },
      },
    }),
    getReceivables({ companyId }),
    getWarehouseLabels(companyId),
  ]);

  const receivableByInvoice = new Map(receivables.map((r) => [r.invoiceId, r]));

  const rows: SaleRow[] = invoices.map((inv) => {
    const quantity = inv.lines.reduce((a, l) => a.plus(dec(l.quantityKg)), dec(0));
    const receivable = receivableByInvoice.get(inv.id);
    const days = daysUntil(inv.dueDate);

    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: formatDate(inv.invoiceDate),
      invoiceDateSort: inv.invoiceDate.getTime(),
      dueDate: formatDate(inv.dueDate),
      dueDateSort: inv.dueDate?.getTime() ?? 0,
      customerName: inv.customer.customerName,
      customerId: inv.customer.id,
      currency: inv.currency,
      totalAmount: formatMoney(inv.totalAmount, inv.currency),
      totalAmountSort: Number(inv.totalAmountUsd),
      totalAmountUsd: formatMoney(inv.totalAmountUsd, 'USD'),
      quantityLabel: formatQuantityKg(quantity),
      quantitySort: Number(quantity),
      paidLabel: receivable ? formatMoney(receivable.paidAmount, inv.currency) : '—',
      outstandingLabel: receivable ? formatMoney(receivable.outstandingAmount, inv.currency) : '—',
      // In dollars as well, because a total across invoices in dirhams and
      // dollars is only meaningful in one of them.
      paidUsdSort: receivable ? Number(receivable.paidAmountUsd) : 0,
      outstandingUsdSort: receivable ? Number(receivable.outstandingAmountUsd) : 0,
      settlement: receivable?.status ?? 'UNPAID',
      daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0,
      status: inv.status,
      paymentType: inv.paymentType,
      createdBy: inv.createdBy?.name ?? '—',
      items: [...new Set(inv.lines.map((l) => l.item.itemName))].join(', '),
      itemCount: new Set(inv.lines.map((l) => l.item.itemName)).size,
      jobNumber: inv.shipment?.jobNumber ?? null,
      // Derived from each line's batch, never from the invoice header alone.
      reference: summariseReferences(inv.lines.map((l) => l.batch?.purchaseContract?.contractReference ?? null)) ?? inv.shipment?.purchaseContract?.contractReference ?? null,
      references: [...new Set(inv.lines.map((l) => l.batch?.purchaseContract?.contractReference).filter((r): r is string => Boolean(r)))],
      lineSources: inv.lines.map((l) => ({
        reference: l.batch?.purchaseContract?.contractReference ?? '—',
        itemName: l.item.itemName,
        batchNumber: l.batch?.batchNumber ?? '—',
        warehouseName: l.warehouse?.name ?? '—',
        quantityLabel: formatQuantityKg(l.quantityKg),
      })),
      shipmentId: inv.shipment?.id ?? null,
      warehouseNames: warehouses.byInvoice.get(inv.id) ?? '',
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        description="Every line names a batch and the warehouse it leaves. Posting relieves that exact stock and raises the receivable."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Sales' }]}
      />
      <SalesClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.SALES_CREATE)}
        canEdit={can(user, PERMISSIONS.SALES_EDIT)}
        canDelete={can(user, PERMISSIONS.SALES_DELETE)}
        canReverse={can(user, PERMISSIONS.SALES_REVERSE)}
        canApprove={can(user, PERMISSIONS.SALES_APPROVE)}
      />
    </div>
  );
}
