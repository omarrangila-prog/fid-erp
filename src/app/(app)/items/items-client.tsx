'use client';

import * as React from 'react';
import { Plus, Pencil, Coffee } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveCoffeeItemAction, type MasterFormState } from '@/server/actions/master-actions';
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
};

const asOptions = (map: Record<string, string>) =>
  Object.entries(map).map(([value, label]) => ({ value, label }));

const FIELDS: FieldSpec[] = [
  { kind: 'section', title: 'Identity', description: 'How this coffee is referred to on contracts and invoices.' },
  { kind: 'text', name: 'itemCode', label: 'Item code', required: true, placeholder: 'BR-SAN-172' },
  {
    kind: 'text',
    name: 'itemName',
    label: 'Coffee name',
    required: true,
    placeholder: 'Brazil Santos NY2 Screen 17/18',
  },
  { kind: 'select', name: 'coffeeType', label: 'Type', required: true, options: asOptions(COFFEE_TYPE_LABELS) },
  { kind: 'select', name: 'process', label: 'Process', required: true, options: asOptions(COFFEE_PROCESS_LABELS) },

  { kind: 'section', title: 'Origin' },
  { kind: 'text', name: 'originCountry', label: 'Origin country', required: true, placeholder: 'Brazil' },
  { kind: 'text', name: 'region', label: 'Region', placeholder: 'Mogiana' },
  { kind: 'text', name: 'farmEstate', label: 'Farm / estate', full: true },

  { kind: 'section', title: 'Specification' },
  { kind: 'text', name: 'grade', label: 'Grade', placeholder: 'NY2' },
  { kind: 'text', name: 'screenSize', label: 'Screen size', placeholder: '17/18' },
  { kind: 'text', name: 'variety', label: 'Variety', placeholder: 'Mundo Novo' },
  { kind: 'text', name: 'cropYear', label: 'Crop year', placeholder: '2025/26' },
  { kind: 'percent', name: 'moisturePct', label: 'Moisture %', placeholder: '11.5' },
  { kind: 'number', name: 'densityGPerL', label: 'Density (g/L)', placeholder: '700' },

  { kind: 'section', title: 'Packaging', description: 'Bag weight drives the bag count on contracts and receipts.' },
  { kind: 'select', name: 'packagingType', label: 'Packaging', required: true, options: asOptions(PACKAGING_LABELS) },
  { kind: 'number', name: 'bagWeightKg', label: 'Bag weight (KG)', placeholder: '60' },
  {
    kind: 'select',
    name: 'defaultUnit',
    label: 'Default entry unit',
    required: true,
    options: [
      { value: 'KG', label: 'KG — kilograms' },
      { value: 'MT', label: 'MT — metric tons' },
      { value: 'BAG', label: 'BAG — bags' },
    ],
    hint: 'Stock is always held in KG; this is only the unit staff type in.',
  },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'description', label: 'Description', full: true },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

export function ItemsClient({
  rows,
  canCreate,
  openCreate = false,
  canEdit,
  showValue,
}: {
  rows: ItemRow[];
  canCreate: boolean;
  openCreate?: boolean;
  canEdit: boolean;
  showValue: boolean;
}) {
  const [editing, setEditing] = React.useState<ItemRow | null>(null);
  const [creating, setCreating] = React.useState(openCreate && canCreate);

  const columns: DataColumn<ItemRow>[] = [
    {
      id: 'name',
      header: 'Coffee',
      mobile: 'title',
      sortValue: (r) => r.itemName,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.itemName}</span>
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
      id: 'crop',
      header: 'Crop',
      hideable: true,
      defaultHidden: true,
      cell: (r) => r.cropYear ?? '—',
    },
    {
      id: 'bag',
      header: 'Bag',
      numeric: true,
      hideable: true,
      sortValue: (r) => Number(r.bagWeightKg),
      cell: (r) => `${r.bagWeightKg} KG`,
    },
    {
      id: 'available',
      header: 'Available',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.availableKg,
      cell: (r) => (
        <span className={r.availableKg > 0 ? 'font-medium text-ink' : 'text-ink-subtle'}>{r.availableLabel}</span>
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
    ...(canEdit
      ? [
          {
            id: 'actions',
            header: '',
            cell: (r: ItemRow) => (
              <Button variant="ghost" size="icon" aria-label={`Edit ${r.itemName}`} onClick={() => setEditing(r)}>
                <Pencil />
              </Button>
            ),
          } satisfies DataColumn<ItemRow>,
        ]
      : []),
  ];

  void showValue;

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) =>
          `${r.itemName} ${r.itemCode} ${r.originCountry} ${r.region ?? ''} ${r.grade ?? ''} ${r.variety ?? ''} ${r.cropYear ?? ''}`
        }
        searchPlaceholder="Search by name, origin, grade or crop year…"
        emptyTitle="No coffee items yet"
        emptyDescription="Create the coffees you trade. Every contract, batch and invoice references one."
        emptyAction={canCreate ? <Button onClick={() => setCreating(true)}><Plus />Add coffee</Button> : undefined}
        toolbar={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              <span className="hidden sm:inline">New coffee</span>
              <span className="sm:hidden">New</span>
            </Button>
          ) : undefined
        }
      />

      {canCreate ? (
        <MasterFormSheet
          open={creating}
          onOpenChange={setCreating}
          title="New coffee"
          description="Defined once, then referenced by every contract, lot, batch and invoice."
          fields={FIELDS}
          defaults={{
            coffeeType: 'ARABICA',
            process: 'WASHED',
            packagingType: 'JUTE_BAG',
            bagWeightKg: '60',
            defaultUnit: 'KG',
            status: 'ACTIVE',
          }}
          action={
            saveCoffeeItemAction.bind(null, null) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
          submitLabel="Create coffee"
        />
      ) : null}

      {editing ? (
        <MasterFormSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Edit ${editing.itemName}`}
          fields={FIELDS}
          defaults={{ ...editing }}
          action={
            saveCoffeeItemAction.bind(null, editing.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
        />
      ) : null}
    </>
  );
}

export { Coffee };
