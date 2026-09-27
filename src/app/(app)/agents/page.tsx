import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { getAgentSummaries } from '@/lib/services/agent-account';
import { PageHeader } from '@/components/shared/page-header';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveAgentAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Agents' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'agentName', label: 'Agent name', required: true },
  { kind: 'text', name: 'contactPerson', label: 'Contact person' },
  { kind: 'tel', name: 'phone', label: 'Phone' },
  { kind: 'email', name: 'email', label: 'Email' },
  { kind: 'percent', name: 'commissionPct', label: 'Commission %', placeholder: '1.5' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Agent', key: 'agentName', mobile: 'title' },
  { id: 'contact', header: 'Contact', key: 'contactPerson', mobile: 'meta' },
  { id: 'phone', header: 'Phone', key: 'phone', hideable: true },
  { id: 'email', header: 'Email', key: 'email', hideable: true, defaultHidden: true },
  { id: 'commission', header: 'Commission %', key: 'commission', kind: 'number', mobile: 'meta' },
  // Where FID and the agent stand, from his ledger: the whole position first,
  // then what makes it up. Each balance stays in its own account.
  { id: 'position', header: 'Current position', key: 'position', mobile: 'meta' },
  { id: 'holding', header: 'Collections held', key: 'holding', kind: 'number', mobile: 'meta' },
  { id: 'payable', header: 'Commission outstanding', key: 'payable', kind: 'number', mobile: 'meta' },
  { id: 'loanFrom', header: 'Loan payable', key: 'loanFrom', kind: 'number', hideable: true },
  { id: 'loanTo', header: 'Loan receivable', key: 'loanTo', kind: 'number', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Inactive: 'neutral' },
  },
];

export default async function AgentsPage() {
  const user = await requirePageAccess(PERMISSIONS.AGENTS_VIEW);
  const [agents, positions] = await Promise.all([
    prisma.agent.findMany({
      where: { companyId: user.activeCompany.id },
      orderBy: { agentName: 'asc' },
    }),
    getAgentSummaries(user.activeCompany.id),
  ]);
  const positionByAgent = new Map(positions.map((p) => [p.agentId, p.summary]));
  const localCurrency = user.activeCompany.localCurrency;

  const rows: SimpleRow[] = agents.map((a) => ({
    id: a.id,
    title: a.agentName,
    searchText: `${a.agentName} ${a.agentCode} ${a.contactPerson ?? ''}`,
    data: {
      agentName: a.agentName,
      agentCode: a.agentCode,
      contactPerson: a.contactPerson,
      phone: a.phone,
      email: a.email,
      commission: `${a.commissionPct.toString()}%`,
      position: (() => {
        const p = positionByAgent.get(a.id);
        if (!p || p.netLocal.abs().lessThan('0.005')) return 'Nothing either way';
        const first = a.agentName.split(/\s+/)[0];
        return p.netLocal.isPositive()
          ? `${first} owes FID ${formatMoney(p.netLocal, localCurrency)}`
          : `FID owes ${first} ${formatMoney(p.netLocal.abs(), localCurrency)}`;
      })(),
      holding: (() => {
        const p = positionByAgent.get(a.id);
        return p && Number(p.holdingLocal) !== 0 ? formatMoney(p.holdingLocal, localCurrency) : '—';
      })(),
      payable: (() => {
        const p = positionByAgent.get(a.id);
        return p && Number(p.commissionLocal) !== 0 ? formatMoney(p.commissionLocal, localCurrency) : '—';
      })(),
      loanFrom: (() => {
        const p = positionByAgent.get(a.id);
        return p && Number(p.loanFromAgentLocal) !== 0 ? formatMoney(p.loanFromAgentLocal, localCurrency) : '—';
      })(),
      loanTo: (() => {
        const p = positionByAgent.get(a.id);
        return p && Number(p.loanToAgentLocal) !== 0 ? formatMoney(p.loanToAgentLocal, localCurrency) : '—';
      })(),
      status: a.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
    actions: [
      // The agent's one ledger: every collection, commission, loan, settlement and set-off.
      { label: 'Open ledger', href: `/agents/${a.id}`, icon: 'ledger' as const },
      { label: 'Receive from agent', href: `/finance/agent-commission?agent=${a.id}`, icon: 'moneyIn' as const },
    ],
    formValues: {
      agentCode: a.agentCode,
      agentName: a.agentName,
      contactPerson: a.contactPerson,
      phone: a.phone,
      email: a.email,
      commissionPct: a.commissionPct.toString(),
      notes: a.notes,
      status: a.status,
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="People who collect from customers or earn commission. Names are master records — add, edit or deactivate here. Historical receipts keep the agent they were posted against."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Agents' }]}
      />
      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE', commissionPct: '0' }}
        action={saveAgentAction}
        entityLabel="Agent"
        deleteTarget="agent"
        canCreate={can(user, PERMISSIONS.AGENTS_MANAGE)}
        canEdit={can(user, PERMISSIONS.AGENTS_MANAGE)}
        emptyDescription="Add the clearing and forwarding agents you work with."
        searchPlaceholder="Search agents…"
      />
    </div>
  );
}
