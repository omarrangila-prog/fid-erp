'use client';

import * as React from 'react';
import { Plus, Pencil } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, STATUS_OPTIONS, CURRENCY_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveCustomerAction, type MasterFormState } from '@/server/actions/master-actions';

export type CustomerRow = {
  id: string;
  customerCode: string;
  customerName: string;
  country: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  primaryCurrency: string;
  creditLimit: string;
  creditLimitLabel: string;
  paymentTermDays: number;
  outstandingLabel: string;
  outstandingUsd: number;
  invoiceCount: number;
  status: string;
  address: string | null;
  whatsapp: string | null;
  notes: string | null;
};

const FIELDS = (defaultCurrency: string): FieldSpec[] => [
  { kind: 'section', title: 'Identity' },
  { kind: 'text', name: 'customerCode', label: 'Customer code', required: true, placeholder: 'CUS-DXB-001' },
  { kind: 'text', name: 'customerName', label: 'Customer name', required: true },
  { kind: 'text', name: 'country', label: 'Country' },
  {
    kind: 'select',
    name: 'primaryCurrency',
    label: 'Ledger currency',
    required: true,
    options: CURRENCY_OPTIONS,
    hint: `This customer's ledger is kept in this currency. ${defaultCurrency} is normal here.`,
  },

  { kind: 'section', title: 'Contact' },
  { kind: 'text', name: 'contactPerson', label: 'Contact person' },
  { kind: 'tel', name: 'phone', label: 'Phone' },
  { kind: 'tel', name: 'whatsapp', label: 'WhatsApp' },
  { kind: 'email', name: 'email', label: 'Email' },
  { kind: 'textarea', name: 'address', label: 'Address', full: true },

  { kind: 'section', title: 'Trading terms' },
  { kind: 'money', name: 'creditLimit', label: 'Credit limit' },
  { kind: 'number', name: 'paymentTermDays', label: 'Payment terms (days)', placeholder: '30' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

export function CustomersClient({
  rows,
  canCreate,
  openCreate = false,
  canEdit,
  defaultCurrency,
}: {
  rows: CustomerRow[];
  canCreate: boolean;
  openCreate?: boolean;
  canEdit: boolean;
  defaultCurrency: string;
}) {
  const [editing, setEditing] = React.useState<CustomerRow | null>(null);
  const [creating, setCreating] = React.useState(openCreate && canCreate);

  const columns: DataColumn<CustomerRow>[] = [
    {
      id: 'name',
      header: 'Customer',
      mobile: 'title',
      sortValue: (r) => r.customerName,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.customerName}</span>
          <span className="block text-xs text-ink-subtle">{r.customerCode}</span>
        </span>
      ),
    },
    { id: 'country', header: 'Country', mobile: 'meta', sortValue: (r) => r.country ?? '', cell: (r) => r.country ?? '—' },
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
      id: 'creditLimit',
      header: 'Credit limit',
      numeric: true,
      hideable: true,
      defaultHidden: true,
      sortValue: (r) => Number(r.creditLimit),
      cell: (r) => r.creditLimitLabel,
    },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.outstandingUsd,
      cell: (r) => (
        <span className={r.outstandingUsd > 0 ? 'font-medium text-ink' : 'text-ink-subtle'}>
          {r.outstandingLabel}
        </span>
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
            cell: (r: CustomerRow) => (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${r.customerName}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(r);
                }}
              >
                <Pencil />
              </Button>
            ),
          } satisfies DataColumn<CustomerRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        rowHref={(r) => `/customers/${r.id}`}
        searchValue={(r) => `${r.customerName} ${r.customerCode} ${r.country ?? ''} ${r.contactPerson ?? ''}`}
        searchPlaceholder="Search customers…"
        emptyTitle="No customers yet"
        emptyDescription="Add the roasters and traders you sell coffee to."
        emptyAction={canCreate ? <Button onClick={() => setCreating(true)}><Plus />Add customer</Button> : undefined}
        toolbar={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              <span className="hidden sm:inline">New customer</span>
              <span className="sm:hidden">New</span>
            </Button>
          ) : undefined
        }
      />

      {canCreate ? (
        <MasterFormSheet
          open={creating}
          onOpenChange={setCreating}
          title="New customer"
          description="Customers are created once and referenced by every sale and receipt."
          fields={FIELDS(defaultCurrency)}
          defaults={{ primaryCurrency: defaultCurrency, paymentTermDays: 30, status: 'ACTIVE', creditLimit: '0' }}
          action={saveCustomerAction.bind(null, null) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>}
          submitLabel="Create customer"
        />
      ) : null}

      {editing ? (
        <MasterFormSheet
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title={`Edit ${editing.customerName}`}
          fields={FIELDS(defaultCurrency)}
          defaults={{
            customerCode: editing.customerCode,
            customerName: editing.customerName,
            country: editing.country,
            contactPerson: editing.contactPerson,
            phone: editing.phone,
            whatsapp: editing.whatsapp,
            email: editing.email,
            address: editing.address,
            primaryCurrency: editing.primaryCurrency,
            creditLimit: editing.creditLimit,
            paymentTermDays: editing.paymentTermDays,
            notes: editing.notes,
            status: editing.status,
          }}
          action={
            saveCustomerAction.bind(null, editing.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
        />
      ) : null}
    </>
  );
}
