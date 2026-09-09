'use client';

import * as React from 'react';
import { Plus, Pencil } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, STATUS_OPTIONS, CURRENCY_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveVendorAction, type MasterFormState } from '@/server/actions/master-actions';

export type VendorRow = {
  id: string;
  vendorCode: string;
  vendorName: string;
  country: string | null;
  contactPerson: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  bankDetails: string | null;
  notes: string | null;
  primaryCurrency: string;
  paymentTermDays: number;
  outstandingUsd: number;
  outstandingLabel: string;
  contractCount: number;
  status: string;
};

const FIELDS: FieldSpec[] = [
  { kind: 'section', title: 'Identity' },
  { kind: 'text', name: 'vendorCode', label: 'Supplier code', required: true, placeholder: 'SUP-DXB-001' },
  { kind: 'text', name: 'vendorName', label: 'Supplier name', required: true, placeholder: 'Fazenda Santa Clara Exportadora' },
  { kind: 'text', name: 'country', label: 'Origin country', placeholder: 'Brazil' },
  {
    kind: 'select',
    name: 'primaryCurrency',
    label: 'Ledger currency',
    required: true,
    options: CURRENCY_OPTIONS,
    hint: 'Overseas coffee suppliers are normally carried in USD for both companies.',
  },

  { kind: 'section', title: 'Contact' },
  { kind: 'text', name: 'contactPerson', label: 'Contact person' },
  { kind: 'tel', name: 'phone', label: 'Phone' },
  { kind: 'tel', name: 'whatsapp', label: 'WhatsApp' },
  { kind: 'email', name: 'email', label: 'Email' },
  { kind: 'textarea', name: 'address', label: 'Address', full: true },

  { kind: 'section', title: 'Settlement' },
  { kind: 'number', name: 'paymentTermDays', label: 'Payment terms (days)', placeholder: '60' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  {
    kind: 'textarea',
    name: 'bankDetails',
    label: 'Bank details',
    full: true,
    hint: 'Beneficiary, IBAN/account, SWIFT and correspondent bank.',
  },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

export function VendorsClient({
  rows,
  canCreate,
  openCreate = false,
  canEdit,
}: {
  rows: VendorRow[];
  canCreate: boolean;
  openCreate?: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState<VendorRow | null>(null);
  const [creating, setCreating] = React.useState(openCreate && canCreate);

  const columns: DataColumn<VendorRow>[] = [
    {
      id: 'name',
      header: 'Supplier',
      mobile: 'title',
      sortValue: (r) => r.vendorName,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.vendorName}</span>
          <span className="block text-xs text-ink-subtle">{r.vendorCode}</span>
        </span>
      ),
    },
    { id: 'country', header: 'Origin', mobile: 'meta', sortValue: (r) => r.country ?? '', cell: (r) => r.country ?? '—' },
    {
      id: 'contact',
      header: 'Contact',
      hideable: true,
      cell: (r) => (
        <span className="text-xs">
          {r.contactPerson ? <span className="block text-ink">{r.contactPerson}</span> : null}
          {r.phone ? <span className="block text-ink-subtle">{r.phone}</span> : null}
          {!r.contactPerson && !r.phone ? '—' : null}
        </span>
      ),
    },
    {
      id: 'currency',
      header: 'Currency',
      mobile: 'meta',
      sortValue: (r) => r.primaryCurrency,
      cell: (r) => <Badge tone="neutral">{r.primaryCurrency}</Badge>,
    },
    {
      id: 'terms',
      header: 'Terms',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.paymentTermDays,
      cell: (r) => `${r.paymentTermDays}d`,
    },
    {
      id: 'contracts',
      header: 'Contracts',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.contractCount,
      cell: (r) => r.contractCount,
    },
    {
      id: 'outstanding',
      header: 'We owe',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.outstandingUsd,
      cell: (r) => (
        <span className={r.outstandingUsd > 0 ? 'font-medium text-ink' : 'text-ink-subtle'}>{r.outstandingLabel}</span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
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
            cell: (r: VendorRow) => (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${r.vendorName}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(r);
                }}
              >
                <Pencil />
              </Button>
            ),
          } satisfies DataColumn<VendorRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        rowHref={(r) => `/vendors/${r.id}`}
        searchValue={(r) => `${r.vendorName} ${r.vendorCode} ${r.country ?? ''} ${r.contactPerson ?? ''}`}
        searchPlaceholder="Search suppliers…"
        emptyTitle="No suppliers yet"
        emptyDescription="Add the exporters and cooperatives you buy green coffee from."
        emptyAction={canCreate ? <Button onClick={() => setCreating(true)}><Plus />Add supplier</Button> : undefined}
        toolbar={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              <span className="hidden sm:inline">New supplier</span>
              <span className="sm:hidden">New</span>
            </Button>
          ) : undefined
        }
      />

      {canCreate ? (
        <MasterFormSheet
          open={creating}
          onOpenChange={setCreating}
          title="New supplier"
          description="Suppliers are referenced by every purchase contract and payment."
          fields={FIELDS}
          defaults={{ primaryCurrency: 'USD', paymentTermDays: 60, status: 'ACTIVE' }}
          action={saveVendorAction.bind(null, null) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>}
          submitLabel="Create supplier"
        />
      ) : null}

      {editing ? (
        <MasterFormSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Edit ${editing.vendorName}`}
          fields={FIELDS}
          defaults={{ ...editing }}
          action={
            saveVendorAction.bind(null, editing.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
        />
      ) : null}
    </>
  );
}
