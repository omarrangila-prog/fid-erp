'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FilePlus2, Pause, Play } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { RowActions } from '@/components/shared/row-actions';
import { generateRecurringAction, setRecurringStatusAction } from '@/server/actions/finance-actions';

export type RecurringRow = {
  id: string;
  name: string;
  frequency: string;
  frequencyLabel: string;
  nextDate: string;
  nextDateSort: number;
  endDate: string | null;
  amount: string;
  category: string;
  status: 'ACTIVE' | 'INACTIVE';
  due: boolean;
  lastCreatedId: string | null;
};

export function RecurringClient({ rows }: { rows: RecurringRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function generate(row: RecurringRow) {
    startTransition(async () => {
      const result = await generateRecurringAction(row.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${result.data.number} prepared as a draft. Check it and post.`);
      router.push(`/finance/expenses/${result.data.expenseId}`);
    });
  }

  function setStatus(row: RecurringRow, status: 'ACTIVE' | 'INACTIVE') {
    startTransition(async () => {
      const result = await setRecurringStatusAction(row.id, status);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(status === 'ACTIVE' ? `${row.name} resumed.` : `${row.name} paused.`);
      router.refresh();
    });
  }

  const columns: DataColumn<RecurringRow>[] = [
    {
      id: 'name',
      header: 'Name',
      mobile: 'title',
      sortValue: (r) => r.name,
      exportValue: (r) => r.name,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    { id: 'category', header: 'Category', mobile: 'meta', exportValue: (r) => r.category, cell: (r) => r.category },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      exportValue: (r) => r.amount,
      cell: (r) => <span className="tabular-nums">{r.amount}</span>,
    },
    { id: 'frequency', header: 'Every', mobile: 'meta', exportValue: (r) => r.frequencyLabel, cell: (r) => r.frequencyLabel },
    {
      id: 'next',
      header: 'Next due',
      sortValue: (r) => r.nextDateSort,
      exportValue: (r) => r.nextDate,
      mobile: 'meta',
      cell: (r) => (
        <span className="flex items-center gap-2">
          {r.nextDate}
          {r.due && r.status === 'ACTIVE' ? <Badge tone="warning">Due</Badge> : null}
        </span>
      ),
    },
    { id: 'until', header: 'Until', hideable: true, exportValue: (r) => r.endDate ?? '', cell: (r) => r.endDate ?? '—' },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      exportValue: (r) => (r.status === 'ACTIVE' ? 'Active' : 'Paused'),
      cell: (r) => (
        <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>{r.status === 'ACTIVE' ? 'Active' : 'Paused'}</Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      cell: (r) => (
        <RowActions
          actions={[
            {
              label: 'Create draft now',
              icon: FilePlus2,
              show: r.status === 'ACTIVE',
              onSelect: () => generate(r),
            },
            ...(r.lastCreatedId
              ? [{ label: 'Last draft', href: `/finance/expenses/${r.lastCreatedId}`, icon: FilePlus2 }]
              : []),
            r.status === 'ACTIVE'
              ? { label: 'Pause', icon: Pause, onSelect: () => setStatus(r, 'INACTIVE') }
              : { label: 'Resume', icon: Play, onSelect: () => setStatus(r, 'ACTIVE') },
          ]}
        />
      ),
    },
  ];

  return (
    <div aria-busy={pending}>
      <DataTable<RecurringRow>
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchPlaceholder="Search recurring expenses…"
        searchValue={(r) => `${r.name} ${r.category}`}
        emptyTitle="Nothing recurs yet"
        emptyDescription="Open any expense and choose Make recurring. A draft will be prepared on each due date for you to check and post."
      />
    </div>
  );
}
