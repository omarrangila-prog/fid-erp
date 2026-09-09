'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { SETTLEMENT_STATUS_META, AGEING_LABELS_CLIENT } from '@/app/(app)/finance/receivables/labels';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type AgeingRow = {
  id: string;
  documentNumber: string;
  documentHref: string;
  date: string;
  dateSort: number;
  dueDate: string;
  dueDateSort: number;
  party: string;
  partyHref: string;
  job: string | null;
  eta: string;
  currency: string;
  original: string;
  paid: string;
  outstanding: string;
  outstandingSort: number;
  outstandingUsd: string;
  bucket: string;
  daysOverdue: number;
  status: string;
};

/** Shared ageing table for receivables and payables. */
export function AgeingClient({
  rows,
  partyLabel,
  documentLabel,
  companyCode,
  reportName,
  canExport,
  exportHref,
  showEta,
}: {
  rows: AgeingRow[];
  partyLabel: string;
  documentLabel: string;
  companyCode: string;
  reportName: string;
  canExport: boolean;
  /** The server route that builds the .xlsx for this list. */
  exportHref?: string;
  showEta?: boolean;
}) {
  const [bucket, setBucket] = React.useState('ALL');
  const [party, setParty] = React.useState('ALL');

  const parties = React.useMemo(() => [...new Set(rows.map((r) => r.party))].sort(), [rows]);

  const filtered = React.useMemo(
    () =>
      rows.filter((r) => (bucket === 'ALL' || r.bucket === bucket) && (party === 'ALL' || r.party === party)),
    [rows, bucket, party],
  );

  const columns: DataColumn<AgeingRow>[] = [
    {
      id: 'document',
      header: documentLabel,
      mobile: 'title',
      sortValue: (r) => r.documentNumber,
      cell: (r) => <span className="font-medium">{r.documentNumber}</span>,
    },
    { id: 'party', header: partyLabel, mobile: 'meta', sortValue: (r) => r.party, cell: (r) => r.party },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    {
      id: 'due',
      header: 'Due',
      mobile: 'meta',
      sortValue: (r) => r.dueDateSort,
      cell: (r) => (
        <span>
          <span className="block">{r.dueDate}</span>
          {r.daysOverdue > 0 ? (
            <span className="block text-xs font-medium text-red-600">{r.daysOverdue}d overdue</span>
          ) : null}
        </span>
      ),
    },
    ...(showEta ? [{ id: 'eta', header: 'ETA', hideable: true, cell: (r: AgeingRow) => r.eta } satisfies DataColumn<AgeingRow>] : []),
    { id: 'job', header: 'Job', hideable: true, cell: (r) => r.job ?? '—' },
    { id: 'original', header: 'Original', numeric: true, hideable: true, cell: (r) => r.original },
    { id: 'paid', header: 'Settled', numeric: true, hideable: true, cell: (r) => r.paid },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.outstandingSort,
      cell: (r) => (
        <span>
          <span className="block font-semibold">{r.outstanding}</span>
          {r.currency !== 'USD' ? <span className="block text-xs text-ink-subtle">{r.outstandingUsd}</span> : null}
        </span>
      ),
    },
    {
      id: 'bucket',
      header: 'Age',
      mobile: 'badge',
      sortValue: (r) => r.bucket,
      cell: (r) => (
        <Badge
          tone={
            r.bucket === 'CURRENT' ? 'success' : r.bucket === 'D1_30' ? 'info' : r.bucket === 'D31_60' ? 'progress' : r.bucket === 'D61_90' ? 'warning' : 'danger'
          }
        >
          {AGEING_LABELS_CLIENT[r.bucket] ?? r.bucket}
        </Badge>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      hideable: true,
      cell: (r) => <StatusBadge status={r.status} meta={SETTLEMENT_STATUS_META} />,
    },
  ];

  return (
    <DataTable
      data={filtered}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => r.documentHref}
      pageSize={50}
      searchValue={(r) => `${r.documentNumber} ${r.party} ${r.job ?? ''}`}
      searchPlaceholder={`Search ${documentLabel.toLowerCase()} or ${partyLabel.toLowerCase()}…`}
      exportHref={canExport ? exportHref : undefined}
      emptyTitle="Nothing outstanding"
      emptyDescription="Everything has been settled."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Filter by ageing bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-10 w-auto min-w-36">
            <option value="ALL">All ages</option>
            {Object.entries(AGEING_LABELS_CLIENT).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by customer" value={party} onChange={(e) => setParty(e.target.value)} className="h-10 w-auto min-w-44">
            <option value="ALL">All {partyLabel.toLowerCase()}s</option>
            {parties.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          {canExport ? (
            <Button
              variant="outline"
              onClick={() =>
                downloadCsv(
                  exportFilename(companyCode, reportName),
                  [documentLabel, partyLabel, 'Date', 'Due', 'Job', 'Currency', 'Original', 'Settled', 'Outstanding', 'Outstanding USD', 'Age', 'Status'],
                  filtered.map((r) => [
                    r.documentNumber, r.party, r.date, r.dueDate, r.job, r.currency,
                    r.original, r.paid, r.outstanding, r.outstandingSort,
                    AGEING_LABELS_CLIENT[r.bucket] ?? r.bucket, r.status,
                  ]),
                )
              }
            >
              <Download />
              <span className="hidden sm:inline">Export</span>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
