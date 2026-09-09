'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';

export type PurchaseRow = {
  id: string;
  contractNumber: string;
  contractReference: string;
  supplierContractNo: string | null;
  contractDate: string;
  contractDateSort: number;
  vendorName: string;
  origin: string | null;
  itemNames: string;
  currency: string;
  totalValueLabel: string;
  totalValueUsd: number;
  quantityLabel: string;
  quantityKg: number;
  bags: number;
  containers: number;
  status: string;
  jobNumber: string | null;
  receivedPct: number;
  receivedLabel: string;
  outstandingLabel: string;
  outstandingUsd: number;
};

export function PurchasesClient({
  rows,
  canCreate,
  showCost,
}: {
  rows: PurchaseRow[];
  canCreate: boolean;
  showCost: boolean;
}) {
  const columns: DataColumn<PurchaseRow>[] = [
    {
      id: 'contract',
      header: 'Contract',
      mobile: 'title',
      sortValue: (r) => r.contractNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.contractNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.contractReference}</span>
        </span>
      ),
    },
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      sortValue: (r) => r.contractDateSort,
      cell: (r) => r.contractDate,
    },
    {
      id: 'vendor',
      header: 'Supplier',
      mobile: 'meta',
      sortValue: (r) => r.vendorName,
      cell: (r) => (
        <span>
          <span className="block">{r.vendorName}</span>
          {r.origin ? <span className="block text-xs text-ink-subtle">{r.origin}</span> : null}
        </span>
      ),
    },
    {
      id: 'coffee',
      header: 'Coffee',
      hideable: true,
      cell: (r) => <span className="block max-w-56 truncate text-xs">{r.itemNames}</span>,
    },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantityKg,
      cell: (r) => (
        <span>
          <span className="block">{r.quantityLabel}</span>
          <span className="block text-xs text-ink-subtle">
            {r.bags.toLocaleString()} bags · {r.containers} ctr
          </span>
        </span>
      ),
    },
    ...(showCost
      ? [
          {
            id: 'value',
            header: 'Contract value',
            numeric: true,
            mobile: 'meta',
            sortValue: (r: PurchaseRow) => r.totalValueUsd,
            cell: (r: PurchaseRow) => r.totalValueLabel,
          } satisfies DataColumn<PurchaseRow>,
        ]
      : []),
    {
      id: 'received',
      header: 'Received',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.receivedPct,
      cell: (r) => (
        <span className={r.receivedPct >= 100 ? 'text-teal-700' : r.receivedPct > 0 ? 'text-amber-700' : 'text-ink-subtle'}>
          {r.receivedLabel}
        </span>
      ),
    },
    {
      id: 'outstanding',
      header: 'We owe',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.outstandingUsd,
      cell: (r) => r.outstandingLabel,
    },
    {
      id: 'job',
      header: 'Job',
      hideable: true,
      cell: (r) => (r.jobNumber ? <Badge tone="neutral">{r.jobNumber}</Badge> : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/purchases/${r.id}`}
      searchValue={(r) =>
        `${r.contractNumber} ${r.contractReference} ${r.supplierContractNo ?? ''} ${r.vendorName} ${r.itemNames} ${r.jobNumber ?? ''}`
      }
      searchPlaceholder="Search by contract, reference, supplier or coffee…"
      emptyTitle="No purchase contracts yet"
      emptyDescription="A purchase contract creates the supplier liability and opens a job. Goods are received separately."
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/purchases/new">
              <Plus />
              New contract
            </Link>
          </Button>
        ) : undefined
      }
      toolbar={
        canCreate ? (
          <Button asChild>
            <Link href="/purchases/new">
              <Plus />
              <span className="hidden sm:inline">New contract</span>
              <span className="sm:hidden">New</span>
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}
