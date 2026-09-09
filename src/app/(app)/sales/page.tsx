import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatMoney, formatQuantityKg, formatDate, daysUntil } from '@/lib/format';
import { getReceivables } from '@/lib/services/receivables';
import { PageHeader } from '@/components/shared/page-header';
import { SalesClient, type SaleRow } from '@/app/(app)/sales/sales-client';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

export default async function SalesPage() {
  const user = await requirePageAccess(PERMISSIONS.SALES_VIEW);
  const companyId = user.activeCompany.id;

  const [invoices, receivables] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { companyId },
      orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
      include: {
        customer: { select: { id: true, customerName: true } },
        shipment: { select: { id: true, jobNumber: true } },
        lines: { select: { quantityKg: true } },
      },
    }),
    getReceivables({ companyId }),
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
      settlement: receivable?.status ?? 'UNPAID',
      daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0,
      status: inv.status,
      jobNumber: inv.shipment?.jobNumber ?? null,
      shipmentId: inv.shipment?.id ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        description="Every line names a batch and the warehouse it leaves. Posting relieves that exact stock and raises the receivable."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Sales' }]}
      />
      <SalesClient rows={rows} canCreate={can(user, PERMISSIONS.SALES_CREATE)} />
    </div>
  );
}
