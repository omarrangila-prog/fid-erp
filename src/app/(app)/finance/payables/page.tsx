import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getPayables, summariseAgeing, AGEING_LABELS } from '@/lib/services/receivables';
import { formatMoney, formatDate, daysUntil } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { AgeingClient, type AgeingRow } from '@/app/(app)/finance/receivables/ageing-client';

export const metadata: Metadata = { title: 'Payables' };
export const dynamic = 'force-dynamic';

export default async function PayablesPage() {
  const user = await requirePageAccess(PERMISSIONS.PAYABLES_VIEW);
  const payables = await getPayables({ companyId: user.activeCompany.id, onlyOutstanding: true });
  const ageing = summariseAgeing(payables);

  const rows: AgeingRow[] = payables.map((p) => {
    const days = daysUntil(p.dueDate);
    return {
      id: p.contractId,
      documentNumber: p.contractNumber,
      documentHref: `/purchases/${p.contractId}`,
      date: formatDate(p.contractDate),
      dateSort: p.contractDate.getTime(),
      dueDate: formatDate(p.dueDate),
      dueDateSort: p.dueDate?.getTime() ?? 0,
      party: p.vendorName,
      partyHref: `/ledgers/vendors/${p.vendorId}`,
      job: p.shipmentNumbers.join(', ') || null,
      eta: '—',
      currency: p.currency,
      original: formatMoney(p.purchaseValue, p.currency),
      paid: formatMoney(p.paidAmount, p.currency),
      outstanding: formatMoney(p.outstandingAmount, p.currency),
      outstandingSort: Number(p.outstandingAmountUsd),
      outstandingUsd: formatMoney(p.outstandingAmountUsd, 'USD'),
      bucket: p.bucket,
      daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0,
      status: p.status,
    };
  });

  const total = payables.reduce((a, p) => a.plus(p.outstandingAmountUsd), ageing[0].amountUsd.minus(ageing[0].amountUsd));
  const overdue = ageing.filter((a) => a.bucket !== 'CURRENT').reduce((a, b) => a.plus(b.amountUsd), total.minus(total));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payables"
        description="What the company owes suppliers against approved purchase contracts."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Payables' }]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Total outstanding" value={formatMoney(total, 'USD')} />
        <StatCard label="Overdue" value={formatMoney(overdue, 'USD')} tone={overdue.greaterThan(0) ? 'negative' : 'default'} />
        {ageing.map((bucket) => (
          <StatCard key={bucket.bucket} label={AGEING_LABELS[bucket.bucket]} value={formatMoney(bucket.amountUsd, 'USD')} />
        ))}
      </div>

      <AgeingClient
        rows={rows}
        partyLabel="Supplier"
        documentLabel="Contract"
        companyCode={user.activeCompany.code}
        reportName="payables"
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
