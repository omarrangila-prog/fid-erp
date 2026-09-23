'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Pencil, Power } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import {
  deleteMasterAction,
  toggleMasterStatusAction,
  type MasterFormState,
  type MasterDeleteTarget,
} from '@/server/actions/master-actions';
import { RowActions, type RowAction } from '@/components/shared/row-actions';
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
  /** Screen-specific row actions, shown before Edit. */
  actions?: RowAction[];
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
  deleteTarget,
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
  /**
   * Which master this is, so a record that was never used can be deleted.
   *
   * One that has been used cannot: an invoice whose customer is a blank is
   * worse than a list with an old name on it. The answer says what is in the
   * way and offers Inactive instead.
   */
  deleteTarget?: MasterDeleteTarget;
}) {
  const router = useRouter();
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
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (row: SimpleRow) => (
        <RowActions
          actions={[
            ...(row.actions ?? []),
            { label: 'Edit', icon: Pencil, show: canEdit, onSelect: () => setEditing(row) },
            ...(deleteTarget && canEdit
              ? [
                  {
                    label: String(row.data.status ?? '').toLowerCase() === 'inactive' ? 'Reactivate' : 'Deactivate',
                    icon: Power,
                    overflowOnly: true,
                    onSelect: async () => {
                      const inactive = String(row.data.status ?? '').toLowerCase() === 'inactive';
                      const result = await toggleMasterStatusAction(
                        deleteTarget,
                        row.id,
                        inactive ? 'ACTIVE' : 'INACTIVE',
                      );
                      if (result.ok) {
                        toast.success(inactive ? `${entityLabel} reactivated.` : `${entityLabel} deactivated.`);
                        router.refresh();
                      } else {
                        toast.error(result.error);
                      }
                    },
                  } satisfies RowAction,
                ]
              : []),
          ]}
          destructive={
            deleteTarget && canEdit
              ? {
                  status: 'DRAFT',
                  noun: entityLabel.toLowerCase(),
                  description: `This removes the ${entityLabel.toLowerCase()} entirely. It is only possible while nothing has used it; once it is on a document it can be deactivated instead, which takes it out of every list and leaves the history readable.`,
                  run: async () => {
                    const result = await deleteMasterAction(deleteTarget, row.id);
                    return { ok: result.ok, error: result.ok ? undefined : result.error };
                  },
                }
              : undefined
          }
        />
      ),
    } satisfies DataColumn<SimpleRow>,
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
              <span className="hidden sm:inline">Add {entityLabel.toLowerCase()}</span>
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
