'use client';

import * as React from 'react';
import { Pencil, Plus, Scale } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MasterFormSheet, STATUS_OPTIONS, CURRENCY_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveCustomerAction, toggleMasterStatusAction, type MasterFormState } from '@/server/actions/master-actions';
import { BookOpen, FileText, HandCoins } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { PartyOpeningSheet } from '@/components/shared/party-opening';

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
  outstandingLabel: string;
  outstandingUsd: number;
  invoiceCount: number;
  soldLabel: string;
  soldSort: number;
  receivedLabel: string;
  lastTradedLabel: string;
  lastTradedSort: number;
  status: string;
  address: string | null;
  whatsapp: string | null;
  notes: string | null;
};

const FIELDS = (defaultCurrency: string): FieldSpec[] => [
  { kind: 'section', title: 'Identity' },
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
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

export function CustomersClient({
  rows,
  canCreate,
  openCreate = false,
  canEdit,
  canPostOpening,
  localCurrency,
  defaultLocalRate,
  defaultCurrency,
}: {
  rows: CustomerRow[];
  canCreate: boolean;
  openCreate?: boolean;
  canEdit: boolean;
  canPostOpening: boolean;
  localCurrency: string;
  defaultLocalRate: string;
  defaultCurrency: string;
}) {
  const [editing, setEditing] = React.useState<CustomerRow | null>(null);
  const [opening, setOpening] = React.useState<CustomerRow | null>(null);
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
      id: 'creditLimit',
      header: 'Credit limit',
      numeric: true,
      hideable: true,
      defaultHidden: true,
      sortValue: (r) => Number(r.creditLimit),
      cell: (r) => r.creditLimitLabel,
    },
    {
      id: 'sold',
      header: 'Total sales',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.soldSort,
      exportValue: (r) => r.soldLabel,
      cell: (r) => r.soldLabel,
    },
    {
      id: 'received',
      header: 'Received',
      numeric: true,
      hideable: true,
      exportValue: (r) => r.receivedLabel,
      cell: (r) => r.receivedLabel,
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
      id: 'lastTraded',
      header: 'Last invoice',
      hideable: true,
      sortValue: (r) => r.lastTradedSort,
      exportValue: (r) => r.lastTradedLabel,
      cell: (r) => <span className="whitespace-nowrap">{r.lastTradedLabel}</span>,
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
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (r: CustomerRow) => (
        <RowActions
          actions={[
            viewAction(`/customers/${r.id}`),
            { label: 'Edit', icon: Pencil, show: canEdit, onSelect: () => setEditing(r) },
            { label: 'Ledger', href: `/ledgers/customers?customer=${r.id}`, icon: BookOpen },
            {
              label: 'Opening balance',
              icon: Scale,
              show: canPostOpening,
              onSelect: () => setOpening(r),
            },
            { label: 'New invoice', href: `/sales/new?customer=${r.id}`, icon: FileText },
            { label: 'Record payment', href: `/finance/receipts/new?customer=${r.id}`, icon: HandCoins },
          ]}
          destructive={{
            status: r.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
            noun: 'customer',
            show: canEdit,
            cancelLabel: r.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate',
            description:
              r.status === 'ACTIVE'
                ? 'The customer stops appearing on new invoices and receipts. Their history, ledger and open balances are untouched, and they can be reactivated at any time.'
                : 'The customer becomes selectable again on new documents.',
            run: async (reason) => {
              void reason;
              const result = await toggleMasterStatusAction(
                'customer',
                r.id,
                r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
              );
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            },
          }}
        />
      ),
    } satisfies DataColumn<CustomerRow>,
  ];

  return (
    <>
      <DataTable
        data={rows}
          filters={[
            { id: 'status', label: 'Status', value: (r) => r.status },
            { id: 'currency', label: 'Currency', value: (r) => r.primaryCurrency },
            { id: 'country', label: 'Country', value: (r) => r.country },
          ]}
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
          defaults={{ primaryCurrency: defaultCurrency, status: 'ACTIVE', creditLimit: '0' }}
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
            notes: editing.notes,
            status: editing.status,
          }}
          action={
            saveCustomerAction.bind(null, editing.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>
          }
        />
      ) : null}

      {opening ? (
        <PartyOpeningSheet
          party="CUSTOMER"
          id={opening.id}
          name={opening.customerName}
          currency={opening.primaryCurrency}
          localCurrency={localCurrency}
          defaultLocalRate={defaultLocalRate}
          open
          onOpenChange={(next) => !next && setOpening(null)}
        />
      ) : null}
    </>
  );
}

/** Edit from the customer detail page — same sheet as the list, same save path. */
export function CustomerEditButton({
  customer,
  defaultCurrency,
}: {
  customer: {
    id: string;
    customerCode: string;
    customerName: string;
    country: string | null;
    contactPerson: string | null;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    address: string | null;
    primaryCurrency: string;
    creditLimit: string;
    notes: string | null;
    status: string;
  };
  defaultCurrency: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil />
        Edit
      </Button>
      <MasterFormSheet
        open={open}
        onOpenChange={setOpen}
        title={`Edit ${customer.customerName}`}
        fields={FIELDS(defaultCurrency)}
        defaults={customer}
        action={saveCustomerAction.bind(null, customer.id) as (p: MasterFormState, f: FormData) => Promise<MasterFormState>}
      />
    </>
  );
}
