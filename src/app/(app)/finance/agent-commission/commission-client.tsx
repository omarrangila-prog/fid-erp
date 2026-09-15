'use client';

import * as React from 'react';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';

export type CommissionRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  agentId: string;
  agentName: string;
  contractId: string | null;
  contractReference: string | null;
  jobId: string | null;
  job: string | null;
  container: string | null;
  currency: string;
  amount: string;
  amountUsd: string;
  amountUsdSort: number;
  rate: string;
  paidUsd: string;
  remainingUsd: string;
  remainingSort: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID';
};

const STATUS: Record<CommissionRow['status'], { label: string; tone: 'warning' | 'progress' | 'success' }> = {
  UNPAID: { label: 'Unpaid', tone: 'warning' },
  PARTIAL: { label: 'Partially paid', tone: 'progress' },
  PAID: { label: 'Paid', tone: 'success' },
};

export function AgentCommissionClient({ rows }: { rows: CommissionRow[] }) {
  const columns: DataColumn<CommissionRow>[] = [
    {
      id: 'number',
      header: 'Voucher',
      mobile: 'title',
      sortValue: (r) => r.number,
      cell: (r) => (
        <Link href={`/finance/expenses/${r.id}`} className="font-medium text-forest-800 hover:underline">
          {r.number}
        </Link>
      ),
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    {
      id: 'agent',
      header: 'Agent',
      mobile: 'meta',
      sortValue: (r) => r.agentName,
      cell: (r) => (
        <Link href={`/agents/${r.agentId}`} className="text-forest-800 hover:underline">
          {r.agentName}
        </Link>
      ),
    },
    {
      id: 'contract',
      header: 'Contract Ref',
      cell: (r) =>
        r.contractId ? (
          <Link href={`/purchases/${r.contractId}`} className="hover:underline">
            {r.contractReference}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      id: 'job',
      header: 'Shipment',
      hideable: true,
      cell: (r) =>
        r.jobId ? (
          <Link href={`/shipments/${r.jobId}`} className="hover:underline">
            {r.job}
          </Link>
        ) : (
          '—'
        ),
    },
    { id: 'container', header: 'Container', hideable: true, cell: (r) => r.container ?? '—' },
    { id: 'currency', header: 'Currency', hideable: true, cell: (r) => r.currency },
    { id: 'amount', header: 'Amount', numeric: true, cell: (r) => r.amount },
    { id: 'rate', header: 'Rate to USD', numeric: true, hideable: true, cell: (r) => r.rate },
    {
      id: 'usd',
      header: 'USD',
      numeric: true,
      sortValue: (r) => r.amountUsdSort,
      cell: (r) => r.amountUsd,
    },
    { id: 'paid', header: 'Paid USD', numeric: true, hideable: true, cell: (r) => r.paidUsd },
    {
      id: 'remaining',
      header: 'Outstanding USD',
      numeric: true,
      sortValue: (r) => r.remainingSort,
      cell: (r) => r.remainingUsd,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      searchValue={(r) =>
        [r.number, r.agentName, r.contractReference, r.job, r.container].filter(Boolean).join(' ')
      }
      emptyTitle="No agent commission yet"
      emptyDescription="Record an unpaid shipment expense owed to an agent. It appears here immediately, even before it is paid."
    />
  );
}
