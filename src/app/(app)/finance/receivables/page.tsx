import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getReceivables, summariseAgeing, AGEING_LABELS } from '@/lib/services/receivables';
import { formatMoney, formatDate, daysUntil } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { AgeingClient, type AgeingRow } from '@/app/(app)/finance/receivables/ageing-client';

export const metadata: Metadata = { title: 'Receivables' };
export const dynamic = 'force-dynamic';

export default async function ReceivablesPage() {
  const user = await requirePageAccess(PERMISSIONS.RECEIVABLES_VIEW);
  const receivables = await getReceivables({ companyId: user.activeCompany.id, onlyOutstanding: true });
  const ageing = summariseAgeing(receivables);

  const rows: AgeingRow[] = receivables.map((r) => {
    const days = daysUntil(r.dueDate);
    return {
      id: r.invoiceId,
      documentNumber: r.invoiceNumber,
      documentHref: `/sales/${r.invoiceId}`,
      date: formatDate(r.invoiceDate),
      dateSort: r.invoiceDate.getTime(),
      dueDate: formatDate(r.dueDate),
      dueDateSort: r.dueDate?.getTime() ?? 0,
      party: r.customerName,
      partyHref: `/ledgers/customers/${r.customerId}`,
      job: r.shipmentNumber,
      eta: formatDate(r.etaDate),
      currency: r.currency,
      original: formatMoney(r.originalAmount, r.currency),
      paid: formatMoney(r.paidAmount, r.currency),
      outstanding: formatMoney(r.outstandingAmount, r.currency),
      outstandingSort: Number(r.outstandingAmountUsd),
      outstandingUsd: formatMoney(r.outstandingAmountUsd, 'USD'),
      bucket: r.bucket,
      daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0,
      status: r.status,
    };
  });

  const total = receivables.reduce((a, r) => a.plus(r.outstandingAmountUsd), ageing[0].amountUsd.minus(ageing[0].amountUsd));
  const overdue = ageing.filter((a) => a.bucket !== 'CURRENT').reduce((a, b) => a.plus(b.amountUsd), total.minus(total));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receivables"
        description="What customers owe, and how long it has been owed."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Receivables' }]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Total outstanding" value={formatMoney(total, 'USD')} />
        <StatCard label="Overdue" value={formatMoney(overdue, 'USD')} tone={overdue.greaterThan(0) ? 'negative' : 'default'} />
        {ageing.map((bucket) => (
          <StatCard key={bucket.bucket} label={AGEING_LABELS[bucket.bucket]} value={formatMoney(bucket.amountUsd, 'USD')} />
        ))}
      </div>

      <AgeingClient
        exportHref="/api/export/receivables"
        rows={rows}
        partyLabel="Customer"
        documentLabel="Invoice"
        companyCode={user.activeCompany.code}
        reportName="receivables"
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
        showEta
      />
    </div>
  );
}
