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
  warehouseNames: string;
};

export function PurchasesClient({
  rows,
  canCreate,
  showCost,
  canEdit = false,
}: {
  rows: PurchaseRow[];
  canCreate: boolean;
  showCost: boolean;
  canEdit?: boolean;
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
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
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
        <span className={r.receivedPct >= 100 ? 'text-gold-700' : r.receivedPct > 0 ? 'text-amber-700' : 'text-ink-subtle'}>
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
      exportValue: (r) => TRANSACTION_STATUS_META[r.status]?.label ?? r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      /*
       * Whether the coffee has actually turned up.
       *
       * "Posted" only says the contract is approved and the supplier is owed.
       * The question asked of this screen every day is a different one — has it
       * arrived — and answering it meant opening the contract and comparing two
       * quantities. The percentage is still in its own column for anyone who
       * wants the detail; this is the answer in a word.
       */
      id: 'goods',
      header: 'Goods',
      mobile: 'badge',
      sortValue: (r) => r.receivedPct,
      exportValue: (r) => goodsState(r).label,
      cell: (r) => {
        if (r.status !== 'POSTED') return <span className="text-ink-subtle">—</span>;
        const state = goodsState(r);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      printHidden: true,
      mobile: 'action',
      className: 'sticky right-0 z-10 bg-surface shadow-[-8px_0_12px_-8px_rgba(15,23,42,0.18)]',
      cell: (r) => (
        <div className="flex flex-wrap justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button asChild variant="outline" size="sm">
            <Link href={`/purchases/${r.id}`}>View</Link>
          </Button>
          {canEdit && r.status === 'DRAFT' ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/purchases/${r.id}/edit`}>Edit</Link>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/purchases/${r.id}`}
      searchValue={(r) =>
        `${r.contractNumber} ${r.contractReference} ${r.supplierContractNo ?? ''} ${r.vendorName} ${r.itemNames} ${r.jobNumber ?? ''} ${r.warehouseNames}`
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


/** Received, part received, or still to come. */
function goodsState(row: PurchaseRow): { label: string; tone: 'success' | 'progress' | 'neutral' } {
  if (row.receivedPct >= 100) return { label: 'Received', tone: 'success' };
  if (row.receivedPct > 0) return { label: 'Part received', tone: 'progress' };
  return { label: 'Awaiting goods', tone: 'neutral' };
}
