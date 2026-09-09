'use client';

import * as React from 'react';
import { Plus, Pencil } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import type { MasterFormState } from '@/server/actions/master-actions';
import type { BadgeTone } from '@/lib/constants';

/**
 * A list screen for the smaller master records — warehouses, agents, shipping
 * lines, expense categories.
 *
 * Columns are described as plain data rather than render functions so the whole
 * definition can be built on the server and handed across the boundary. That
 * keeps four near-identical screens down to one component.
 */

export type SimpleColumnSpec = {
  id: string;
  header: string;
  /** Key into the row's `data` record. */
  key: string;
  kind?: 'text' | 'number' | 'badge' | 'muted';
  tone?: BadgeTone;
  /** Per-value tone overrides for badge columns. */
  tones?: Record<string, BadgeTone>;
  mobile?: 'title' | 'badge' | 'meta' | 'hidden';
  hideable?: boolean;
  defaultHidden?: boolean;
};

export type SimpleRow = {
  id: string;
  data: Record<string, string | number | null>;
  /** Values used to pre-fill the edit form. */
  formValues: Record<string, string | number | boolean | null>;
  searchText: string;
  title: string;
};

export function SimpleMasterTable({
  rows,
  columns,
  fields,
  createDefaults,
  action,
  entityLabel,
  canCreate,
  canEdit,
  emptyDescription,
  searchPlaceholder,
}: {
  rows: SimpleRow[];
  columns: SimpleColumnSpec[];
  fields: FieldSpec[];
  createDefaults: Record<string, string | number | boolean | null>;
  /** Server action already curried with the record id (null when creating). */
  action: (id: string | null, prev: MasterFormState, formData: FormData) => Promise<MasterFormState>;
  entityLabel: string;
  canCreate: boolean;
  canEdit: boolean;
  emptyDescription: string;
  searchPlaceholder: string;
}) {
  const [editing, setEditing] = React.useState<SimpleRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  const tableColumns: DataColumn<SimpleRow>[] = [
    ...columns.map(
      (spec): DataColumn<SimpleRow> => ({
        id: spec.id,
        header: spec.header,
        numeric: spec.kind === 'number',
        mobile: spec.mobile,
        hideable: spec.hideable,
        defaultHidden: spec.defaultHidden,
        sortValue: (row) => {
          const value = row.data[spec.key];
          return typeof value === 'number' ? value : String(value ?? '');
        },
        cell: (row) => {
          const value = row.data[spec.key];
          if (value === null || value === '') return <span className="text-ink-subtle">—</span>;
          if (spec.kind === 'badge') {
            return <Badge tone={spec.tones?.[String(value)] ?? spec.tone ?? 'neutral'}>{String(value)}</Badge>;
          }
          if (spec.kind === 'muted') return <span className="text-xs text-ink-subtle">{String(value)}</span>;
          return <span>{String(value)}</span>;
        },
      }),
    ),
    ...(canEdit
      ? [
          {
            id: 'actions',
            header: '',
            cell: (row: SimpleRow) => (
              <Button variant="ghost" size="icon" aria-label={`Edit ${row.title}`} onClick={() => setEditing(row)}>
                <Pencil />
              </Button>
            ),
          } satisfies DataColumn<SimpleRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={tableColumns}
        getRowId={(row) => row.id}
        searchValue={(row) => row.searchText}
        searchPlaceholder={searchPlaceholder}
        emptyTitle={`No ${entityLabel.toLowerCase()}s yet`}
        emptyDescription={emptyDescription}
        emptyAction={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              Add {entityLabel.toLowerCase()}
            </Button>
          ) : undefined
        }
        toolbar={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              <span className="hidden sm:inline">New {entityLabel.toLowerCase()}</span>
              <span className="sm:hidden">New</span>
            </Button>
          ) : undefined
        }
      />

      {canCreate ? (
        <MasterFormSheet
          open={creating}
          onOpenChange={setCreating}
          title={`New ${entityLabel.toLowerCase()}`}
          fields={fields}
          defaults={createDefaults}
          action={action.bind(null, null)}
          submitLabel={`Create ${entityLabel.toLowerCase()}`}
        />
      ) : null}

      {editing ? (
        <MasterFormSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Edit ${editing.title}`}
          fields={fields}
          defaults={editing.formValues}
          action={action.bind(null, editing.id)}
        />
      ) : null}
    </>
  );
}
