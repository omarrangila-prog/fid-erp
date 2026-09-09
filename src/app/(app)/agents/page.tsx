import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveAgentAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Agents' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'agentCode', label: 'Agent code', required: true, placeholder: 'AGT-DXB-01' },
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
  { id: 'code', header: 'Code', key: 'agentCode', mobile: 'meta' },
  { id: 'contact', header: 'Contact', key: 'contactPerson', mobile: 'meta' },
  { id: 'phone', header: 'Phone', key: 'phone', hideable: true },
  { id: 'email', header: 'Email', key: 'email', hideable: true, defaultHidden: true },
  { id: 'commission', header: 'Commission', key: 'commission', kind: 'number', mobile: 'meta' },
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
  const agents = await prisma.agent.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: { agentName: 'asc' },
  });

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
      status: a.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
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
        description="Clearing, forwarding and commission agents. Expenses and cheques can be attributed to an agent."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Agents' }]}
      />
      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE', commissionPct: '0' }}
        action={saveAgentAction}
        entityLabel="Agent"
        canCreate={can(user, PERMISSIONS.AGENTS_MANAGE)}
        canEdit={can(user, PERMISSIONS.AGENTS_MANAGE)}
        emptyDescription="Add the clearing and forwarding agents you work with."
        searchPlaceholder="Search agents…"
      />
    </div>
  );
}
