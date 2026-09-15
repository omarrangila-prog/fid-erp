import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getAgentCommissionRegister } from '@/lib/services/agent-commission';
import { formatMoney, formatDate, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/feedback';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { ExcelLink, exportHref } from '@/components/shared/excel-link';
import { dec } from '@/lib/money';
import {
  AgentCommissionClient,
  type CommissionRow,
} from '@/app/(app)/finance/agent-commission/commission-client';

export const metadata: Metadata = { title: 'Agent Commission' };
export const dynamic = 'force-dynamic';

export default async function AgentCommissionPage() {
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const rows = await getAgentCommissionRegister(user.activeCompany.id);

  const outstanding = rows.reduce((sum, row) => sum.plus(row.remainingUsd), dec(0));
  const unpaidCount = rows.filter((row) => row.status !== 'PAID').length;

  const tableRows: CommissionRow[] = rows.map((row) => ({
    id: row.expenseId,
    number: row.expenseNumber,
    date: formatDate(row.expenseDate),
    dateSort: row.expenseDate.getTime(),
    agentId: row.agentId,
    agentName: row.agentName,
    contractId: row.contractId,
    contractReference: row.contractReference,
    jobId: row.shipmentId,
    job: row.jobNumber,
    container: row.containerNumber,
    currency: row.currency,
    amount: formatMoney(row.amount, row.currency),
    amountUsd: formatMoney(row.amountUsd, 'USD'),
    amountUsdSort: Number(row.amountUsd),
    rate: formatRate(row.rateToUsd),
    paidUsd: formatMoney(row.paidUsd, 'USD'),
    remainingUsd: formatMoney(row.remainingUsd, 'USD'),
    remainingSort: Number(row.remainingUsd),
    status: row.status,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Commission"
        description="Commission agreed on a shipment, whether or not it has been paid. Unpaid amounts are already in the shipment cost."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Agent Commission' }]}
        actions={
          <>
            {can(user, PERMISSIONS.REPORTS_EXPORT) ? (
              <ExcelLink href={exportHref('agent-commission', {})} />
            ) : null}
            {can(user, PERMISSIONS.EXPENSES_CREATE) ? (
              <Button asChild>
                <Link href="/finance/expenses/new">
                  <Plus />
                  Record commission
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <MetricGrid>
        <Metric label="Lines" value={String(rows.length)} />
        <Metric label="Still unpaid" value={String(unpaidCount)} tone={unpaidCount > 0 ? 'negative' : 'default'} />
        <Metric
          label="Outstanding"
          value={formatMoney(outstanding, 'USD')}
          tone={outstanding.greaterThan(0) ? 'negative' : 'default'}
        />
      </MetricGrid>

      <Callout tone="info" title="Paid later does not rewrite the shipment">
        Entering commission unpaid raises Agent Commission Payable and the job cost immediately. Paying the agent
        later reduces that payable and cash or bank — it does not change the original shipment cost.
      </Callout>

      <AgentCommissionClient rows={tableRows} />
    </div>
  );
}
