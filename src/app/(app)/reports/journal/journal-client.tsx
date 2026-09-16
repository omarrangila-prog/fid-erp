'use client';

import * as React from 'react';
import { FileText, Printer } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { journalSourceEditHref, journalSourceHref } from '@/lib/journal-source';

/**
 * Every posted voucher, one to a row, with its lines underneath.
 *
 * It used to be a stack of cards, one per voucher, each carrying its own
 * table: readable for three entries and unusable for three hundred, with no
 * way to sort by amount or find the one that is out. A voucher is a row now —
 * number, date, description, currency, totals, status, who posted it — and
 * its lines open in place rather than on another screen, which is what §18
 * and §23 are both asking for.
 */

export type JournalLineRow = {
  id: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  currency: string;
  debit: string;
  credit: string;
  usd: string;
  local: string;
};

export type JournalEntryRow = {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryDateSort: number;
  description: string;
  sourceType: string;
  sourceTypeLabel: string;
  sourceId: string | null;
  currency: string;
  totalDebit: string;
  totalCredit: string;
  totalSort: number;
  isReversal: boolean;
  createdBy: string;
  postedAt: string;
  lines: JournalLineRow[];
};

export function JournalClient({
  rows,
  localCurrency,
}: {
  rows: JournalEntryRow[];
  localCurrency: string;
}) {
  const columns: DataColumn<JournalEntryRow>[] = [
    {
      id: 'voucher',
      header: 'Voucher',
      mobile: 'title',
      pin: 'left',
      sortValue: (r) => r.entryNumber,
      exportValue: (r) => r.entryNumber,
      cell: (r) => (
        <span className="whitespace-nowrap font-medium">
          {r.entryNumber}
          {r.isReversal ? (
            <Badge tone="danger" className="ml-2">
              Reversal
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      sortValue: (r) => r.entryDateSort,
      exportValue: (r) => r.entryDate,
      cell: (r) => <span className="whitespace-nowrap">{r.entryDate}</span>,
    },
    {
      id: 'description',
      header: 'Description',
      mobile: 'meta',
      sortValue: (r) => r.description,
      exportValue: (r) => r.description,
      cell: (r) => <span className="block min-w-56">{r.description}</span>,
    },
    {
      id: 'source',
      header: 'Source',
      mobile: 'badge',
      hideable: true,
      sortValue: (r) => r.sourceTypeLabel,
      exportValue: (r) => r.sourceTypeLabel,
      cell: (r) => <Badge tone="neutral">{r.sourceTypeLabel}</Badge>,
    },
    {
      id: 'currency',
      header: 'Currency',
      hideable: true,
      sortValue: (r) => r.currency,
      exportValue: (r) => r.currency,
      cell: (r) => r.currency,
    },
    {
      id: 'debit',
      header: 'Total debit',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.totalSort,
      exportValue: (r) => r.totalDebit,
      cell: (r) => r.totalDebit,
    },
    {
      id: 'credit',
      header: 'Total credit',
      numeric: true,
      hideable: true,
      exportValue: (r) => r.totalCredit,
      cell: (r) => r.totalCredit,
    },
    {
      id: 'lineCount',
      header: 'Lines',
      numeric: true,
      hideable: true,
      defaultHidden: true,
      sortValue: (r) => r.lines.length,
      exportValue: (r) => r.lines.length,
      cell: (r) => r.lines.length,
    },
    {
      id: 'createdBy',
      header: 'Posted by',
      hideable: true,
      sortValue: (r) => r.createdBy,
      exportValue: (r) => r.createdBy,
      cell: (r) => <span className="whitespace-nowrap text-xs text-ink-muted">{r.createdBy}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      exportValue: (r) => (r.isReversal ? 'Reversal' : 'Posted'),
      cell: (r) => <Badge tone={r.isReversal ? 'danger' : 'success'}>{r.isReversal ? 'Reversal' : 'Posted'}</Badge>,
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (r) => {
        // A voucher's actions belong to the document that raised it: a journal
        // line is never edited on its own. A manual voucher is its own source.
        const view = journalSourceHref(r.sourceType, r.sourceId ?? '', { entryNumber: r.entryNumber });
        const edit = r.sourceId ? journalSourceEditHref(r.sourceType, r.sourceId) : null;
        return (
          <RowActions
            actions={[
              ...(view ? [viewAction(view)] : []),
              {
                label: 'Edit source',
                href: edit ?? '',
                icon: FileText,
                show: Boolean(edit && edit !== view),
              },
              { label: 'Print', href: '#', icon: Printer, onSelect: () => window.print(), overflowOnly: true },
            ]}
          />
        );
      },
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      dense
      pageSize={50}
      searchValue={(r) =>
        `${r.entryNumber} ${r.description} ${r.sourceTypeLabel} ${r.createdBy} ${r.lines
          .map((l) => `${l.accountCode} ${l.accountName}`)
          .join(' ')}`
      }
      searchPlaceholder="Search by voucher, description, account or who posted it…"
      filters={[
        { id: 'source', label: 'Source', value: (r) => r.sourceTypeLabel },
        { id: 'currency', label: 'Currency', value: (r) => r.currency },
        { id: 'postedBy', label: 'Posted by', value: (r) => r.createdBy },
      ]}
      emptyTitle="No entries in this period"
      emptyDescription="Post a document and its journal appears here."
      expandedContent={(r) => (
        <TableWrap className="rounded-none border-0 border-t shadow-none">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Account</TH>
                <TH>Description</TH>
                <TH>Currency</TH>
                <TH numeric>Debit</TH>
                <TH numeric>Credit</TH>
                <TH numeric>USD</TH>
                <TH numeric>{localCurrency}</TH>
              </TR>
            </THead>
            <TBody>
              {r.lines.map((line) => (
                <TR key={line.id}>
                  <TD>
                    <span className="text-ink-subtle">{line.accountCode}</span> {line.accountName}
                  </TD>
                  <TD className="text-xs text-ink-muted">{line.description ?? '—'}</TD>
                  <TD className="text-xs">{line.currency}</TD>
                  <TD numeric>{line.debit}</TD>
                  <TD numeric>{line.credit}</TD>
                  <TD numeric className="text-ink-muted">
                    {line.usd}
                  </TD>
                  <TD numeric className="text-ink-muted">
                    {line.local}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    />
  );
}
