'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Pencil, Coffee } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { MasterFormSheet, STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import {
  saveCoffeeItemAction,
  deactivateCoffeeItemAction,
  type MasterFormState,
} from '@/server/actions/master-actions';
import { History, Layers, ArrowLeftRight } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { COFFEE_TYPE_LABELS, COFFEE_PROCESS_LABELS, PACKAGING_LABELS } from '@/lib/constants';

export type ItemRow = {
  id: string;
  itemCode: string;
  itemName: string;
  coffeeType: string;
  originCountry: string;
  region: string | null;
  farmEstate: string | null;
  grade: string | null;
  screenSize: string | null;
  variety: string | null;
  process: string;
  cropYear: string | null;
  moisturePct: string | null;
  densityGPerL: string | null;
  packagingType: string;
  bagWeightKg: string;
  defaultUnit: string;
  description: string | null;
  notes: string | null;
  status: string;
  availableKg: number;
  availableLabel: string;
  bags: number;
  batchCount: number;
  lastMovedLabel: string;
  lastMovedSort: number;
  warehouses: Array<{ warehouseName: string; availableLabel: string; availableKg: number }>;
};

const asOptions = (map: Record<string, string>) =>
  Object.entries(map).map(([value, label]) => ({ value, label }));

/**
 * FID's item form, not Zoho's.
 *
 * Name, unit, optional SKU, the coffee facts that actually appear on a
 * contract, and batch/lot tracking — which is always on, so there is no
 * switch for it. Sales accounts, inventory accounts and valuation methods
 * are not asked for here.
 */
const FIELDS: FieldSpec[] = [
  { kind: 'section', title: 'Item', description: 'Name it once. Every purchase, loading sheet and invoice then uses this record.' },
  {
    kind: 'text',
    name: 'itemName',
    label: 'Item name',
    required: true,
    placeholder: 'Uganda Robusta Screen 12',
    full: true,
  },
  {
    kind: 'select',
    name: 'defaultUnit',
    label: 'Unit',
    required: true,
    options: [
      { value: 'KG', label: 'KG — kilograms' },
      { value: 'MT', label: 'MT — metric tons' },
      { value: 'BAG', label: 'BAG — bags' },
    ],
    hint: 'Stock is always held in KG. This is only the unit staff type in.',
  },
  {
    kind: 'text',
    name: 'itemCode',
    label: 'SKU',
    placeholder: 'Optional',
    hint: 'Leave blank and the system issues ITM-0001, same as customers.',
  },

  { kind: 'section', title: 'Coffee details' },
  { kind: 'select', name: 'coffeeType', label: 'Type', required: true, options: asOptions(COFFEE_TYPE_LABELS) },
  { kind: 'text', name: 'originCountry', label: 'Origin country', required: true, placeholder: 'Uganda' },
  { kind: 'text', name: 'screenSize', label: 'Screen size', placeholder: '12' },
  { kind: 'text', name: 'grade', label: 'Grade' },
  { kind: 'select', name: 'process', label: 'Process', required: true, options: asOptions(COFFEE_PROCESS_LABELS) },
  { kind: 'text', name: 'cropYear', label: 'Crop year', placeholder: '2025/26' },
  { kind: 'text', name: 'region', label: 'Region' },

  {
    kind: 'section',
    title: 'Packaging',
    description: 'Batch and lot are always tracked. Bag weight drives the bag count on contracts and receipts.',
  },
  { kind: 'select', name: 'packagingType', label: 'Packaging', required: true, options: asOptions(PACKAGING_LABELS) },
  { kind: 'number', name: 'bagWeightKg', label: 'Bag weight (KG)', placeholder: '60' },
  { kind: 'textarea', name: 'description', label: 'Description', full: true },
];

const EDIT_FIELDS: FieldSpec[] = [
  ...FIELDS,
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
];

export function ItemsClient({
  rows,
  canCreate,
  openCreate = false,
  canEdit,
  canDelete,
  showValue,
}: {
  rows: ItemRow[];
  canCreate: boolean;
  openCreate?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  showValue: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<ItemRow | null>(null);
  const [creating, setCreating] = React.useState(openCreate && canCreate);
  const [deactivating, setDeactivating] = React.useState<ItemRow | null>(null);
  const [pending, startTransition] = React.useTransition();

  const columns: DataColumn<ItemRow>[] = [
    {
      id: 'name',
      header: 'Item',
      mobile: 'title',
      sortValue: (r) => r.itemName,
      cell: (r) => (
        <span>
          <span className="block font-medium text-forest-700">{r.itemName}</span>
          <span className="block text-xs text-ink-subtle">{r.itemCode}</span>
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      mobile: 'badge',
      sortValue: (r) => r.coffeeType,
      cell: (r) => (
        <Badge tone={r.coffeeType === 'ARABICA' ? 'success' : r.coffeeType === 'ROBUSTA' ? 'info' : 'neutral'}>
          {COFFEE_TYPE_LABELS[r.coffeeType] ?? r.coffeeType}
        </Badge>
      ),
    },
    {
      id: 'origin',
      header: 'Origin',
      mobile: 'meta',
      sortValue: (r) => r.originCountry,
      cell: (r) => (
        <span>
          <span className="block">{r.originCountry}</span>
          {r.region ? <span className="block text-xs text-ink-subtle">{r.region}</span> : null}
        </span>
      ),
    },
    {
      id: 'grade',
      header: 'Grade / screen',
      mobile: 'meta',
      hideable: true,
      cell: (r) => [r.grade, r.screenSize].filter(Boolean).join(' · ') || '—',
    },
    {
      id: 'process',
      header: 'Process',
      hideable: true,
      sortValue: (r) => r.process,
      cell: (r) => COFFEE_PROCESS_LABELS[r.process] ?? r.process,
    },
    {
      id: 'unit',
      header: 'Unit',
      hideable: true,
      cell: (r) => r.defaultUnit,
    },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouses.map((w) => w.warehouseName).join(', '),
      exportValue: (r) => r.warehouses.map((w) => w.warehouseName).join(', '),
      cell: (r) =>
        r.warehouses.length > 0 ? (
          <span className="block min-w-28">
            {r.warehouses.map((warehouse) => (
              <span key={warehouse.warehouseName} className="block">
                {warehouse.warehouseName}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      id: 'available',
      header: 'Available',
      mobile: 'meta',
      sortValue: (r) => r.availableKg,
      exportValue: (r) =>
        r.warehouses.length > 0
          ? r.warehouses.map((w) => `${w.warehouseName}: ${w.availableLabel}`).join(' · ')
          : r.availableLabel,
      cell: (r) =>
        r.warehouses.length > 0 ? (
          <span className="block min-w-44 space-y-0.5">
            {r.warehouses.map((warehouse) => (
              <span key={warehouse.warehouseName} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink">{warehouse.warehouseName}</span>
                <span className="tnum shrink-0 font-medium text-forest-800">{warehouse.availableLabel}</span>
              </span>
            ))}
            {r.warehouses.length > 1 ? (
              <span className="flex items-baseline justify-between gap-3 border-t border-line pt-0.5 text-xs">
                <span className="text-ink-subtle">Total</span>
                <span className="tnum font-semibold text-ink">{r.availableLabel}</span>
              </span>
            ) : null}
          </span>
        ) : (
          <span className={r.availableKg > 0 ? 'font-medium text-forest-700' : 'text-ink-subtle'}>
            {r.availableLabel}
          </span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>
          {r.status === 'ACTIVE' ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      id: 'batches',
      header: 'Batches',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.batchCount,
      exportValue: (r) => r.batchCount,
      cell: (r) => (r.batchCount > 0 ? r.batchCount : <span className="text-ink-subtle">—</span>),
    },
    {
      id: 'lastMoved',
      header: 'Last movement',
      hideable: true,
      sortValue: (r) => r.lastMovedSort,
      exportValue: (r) => r.lastMovedLabel,
      cell: (r) => <span className="whitespace-nowrap">{r.lastMovedLabel}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (r: ItemRow) => (
        <RowActions
          actions={[
            viewAction(`/items/${r.id}`),
            { label: 'Edit', icon: Pencil, show: canEdit, onSelect: () => setEditing(r) },
            { label: 'Stock ledger', href: `/inventory/movements?item=${r.id}`, icon: History },
            { label: 'Batches', href: `/inventory/batches?item=${r.id}`, icon: Layers },
            { label: 'Transfer', href: '/inventory/transfers/new', icon: ArrowLeftRight, show: r.availableKg > 0 },
          ]}
          destructive={{
            status: 'ACTIVE',
            noun: 'item',
            show: canDelete && r.status === 'ACTIVE',
            cancelLabel: 'Deactivate',
            description:
              'The coffee stops appearing on new contracts and invoices. Existing batches, stock and history are untouched, and it can be reactivated from its own page.',
            run: async (reason) => {
              void reason;
              const result = await deactivateCoffeeItemAction(r.id);
              return { ok: Boolean(result?.ok), error: result && 'error' in result ? result.error : undefined };
            },
          }}
        />
      ),
    } satisfies DataColumn<ItemRow>,
  ];

  void showValue;

  function confirmDeactivate() {
    if (!deactivating) return;
    const row = deactivating;
    startTransition(async () => {
      const result = await deactivateCoffeeItemAction(row.id);
      if (!result?.ok) {
        toast.error(result && 'error' in result ? result.error : 'Could not deactivate this item.');
        return;
      }
      toast.success(result.message);
      setDeactivating(null);
      router.refresh();
    });
  }

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        rowHref={(r) => `/items/${r.id}`}
        searchValue={(r) =>
          `${r.itemName} ${r.itemCode} ${r.originCountry} ${r.region ?? ''} ${r.grade ?? ''} ${r.variety ?? ''} ${r.cropYear ?? ''} ${r.screenSize ?? ''} ${r.warehouses.map((w) => w.warehouseName).join(' ')}`
        }
        searchPlaceholder="Search by name, origin, grade or screen…"
        emptyTitle="No items yet"
        emptyDescription="Create the coffees you trade. Every contract, batch and invoice references one."
        emptyAction={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New Item
            </Button>
          ) : undefined
        }
        toolbar={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              <span className="hidden sm:inline">New Item</span>
              <span className="sm:hidden">New</span>
            </Button>
          ) : undefined
        }
      />

      {canCreate ? (
        <MasterFormSheet
          open={creating}
          onOpenChange={setCreating}
          title="New Item"
          description="Item name, unit, coffee details, then save. Batch and lot are always tracked."
          fields={FIELDS}
          defaults={{
            coffeeType: 'ROBUSTA',
            process: 'NATURAL',
            packagingType: 'JUTE_BAG',
            bagWeightKg: '60',
            defaultUnit: 'KG',
            status: 'ACTIVE',
            originCountry: '',
          }}
          action={
            saveCoffeeItemAction.bind(null, null) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
          submitLabel="Save item"
        />
      ) : null}

      {editing ? (
        <MasterFormSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Edit ${editing.itemName}`}
          fields={EDIT_FIELDS}
          defaults={{
            itemName: editing.itemName,
            itemCode: editing.itemCode,
            coffeeType: editing.coffeeType,
            originCountry: editing.originCountry,
            region: editing.region,
            farmEstate: editing.farmEstate,
            grade: editing.grade,
            screenSize: editing.screenSize,
            variety: editing.variety,
            process: editing.process,
            cropYear: editing.cropYear,
            moisturePct: editing.moisturePct,
            densityGPerL: editing.densityGPerL,
            packagingType: editing.packagingType,
            bagWeightKg: editing.bagWeightKg,
            defaultUnit: editing.defaultUnit,
            description: editing.description,
            notes: editing.notes,
            status: editing.status,
          }}
          action={
            saveCoffeeItemAction.bind(null, editing.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
          before={
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Stock by warehouse</p>
              {editing.warehouses.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {editing.warehouses.map((warehouse) => (
                    <li key={warehouse.warehouseName} className="flex justify-between gap-3">
                      <span className="text-ink">{warehouse.warehouseName}</span>
                      <span className="tnum font-medium text-forest-800">{warehouse.availableLabel}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
                    <span>Total available</span>
                    <span className="tnum">{editing.availableLabel}</span>
                  </li>
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-muted">
                  None of this coffee is in a warehouse yet.{' '}
                  <Link href={`/items/${editing.id}`} className="font-medium text-forest-800 hover:underline">
                    Open the item
                  </Link>{' '}
                  to see the full stock board.
                </p>
              )}
            </div>
          }
        />
      ) : null}

      <Dialog open={Boolean(deactivating)} onOpenChange={(open) => !open && setDeactivating(null)}>
        {deactivating ? (
          <DialogContent
            title={`Deactivate ${deactivating.itemName}?`}
            description="It will no longer appear on new purchase orders or invoices. Existing contracts and stock are unchanged."
          >
            <div className="flex flex-col-reverse gap-2 px-5 pb-5 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setDeactivating(null)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmDeactivate} loading={pending}>
                Deactivate
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

export { Coffee };
