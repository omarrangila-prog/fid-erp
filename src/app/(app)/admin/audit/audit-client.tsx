'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { BadgeTone } from '@/lib/constants';

export type AuditRow = {
  id: string;
  when: string;
  whenSort: number;
  user: string;
  action: string;
  actionLabel: string;
  tone: BadgeTone;
  entityType: string;
  entityId: string;
  before: string | null;
  after: string | null;
  ipAddress: string | null;
};

export function AuditClient({ rows }: { rows: AuditRow[] }) {
  const [open, setOpen] = React.useState<AuditRow | null>(null);

  const columns: DataColumn<AuditRow>[] = [
    { id: 'when', header: 'When', mobile: 'meta', sortValue: (r) => r.whenSort, cell: (r) => r.when },
    { id: 'user', header: 'User', mobile: 'title', sortValue: (r) => r.user, cell: (r) => r.user },
    {
      id: 'action',
      header: 'Action',
      mobile: 'badge',
      sortValue: (r) => r.action,
      cell: (r) => <Badge tone={r.tone}>{r.actionLabel}</Badge>,
    },
    { id: 'entity', header: 'Record', mobile: 'meta', sortValue: (r) => r.entityType, cell: (r) => r.entityType },
    { id: 'ip', header: 'IP', hideable: true, defaultHidden: true, cell: (r) => r.ipAddress ?? '—' },
    {
      id: 'detail',
      header: '',
      cell: (r) =>
        r.before || r.after ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(r)}>
            View
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.user} ${r.actionLabel} ${r.entityType} ${r.action}`}
        searchPlaceholder="Search by user, action or record…"
        emptyTitle="Nothing recorded yet"
        emptyDescription="Postings, reversals, status changes and permission changes appear here."
        pageSize={50}
      />

      {open ? (
        <Sheet
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={open.actionLabel}
          description={`${open.entityType} · ${open.user} · ${open.when}`}
          width="lg"
        >
          <div className="space-y-4">
            {open.before ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Before</p>
                <pre className="overflow-x-auto rounded-lg border border-line bg-forest-50/50 p-3 text-xs leading-relaxed text-ink">
                  {open.before}
                </pre>
              </div>
            ) : null}
            {open.after ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">After</p>
                <pre className="overflow-x-auto rounded-lg border border-line bg-forest-50/50 p-3 text-xs leading-relaxed text-ink">
                  {open.after}
                </pre>
              </div>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
