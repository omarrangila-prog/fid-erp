'use client';

import * as React from 'react';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { DualText } from '@/components/shared/dual-text';

type Equivalent = { text: string; title: string } | null;

export type StatementRow = {
  id: string;
  journalNumber: string;
  documentNumber: string | null;
  date: string;
  dateIso: string;
  typeLabel: string;
  filters: string[];
  shipment: { id: string; reference: string } | null;
  customerName: string | null;
  documents: Array<{ id: string; number: string }>;
  memo: string | null;
  amount: string;
  amountEquivalent: Equivalent;
  receivableChange: number;
  payableChange: number;
  netChange: number;
  runningNet: number;
  status: string;
  createdBy: string | null;
  sourceHref: string | null;
  lines: Array<{
    account: string;
    kind: string;
    currency: string;
    debit: string;
    credit: string;
    debitLocal: string;
    creditLocal: string;
    rate: string | null;
  }>;
};

const STATUS_TONE: Record<string, 'danger' | 'warning' | 'success' | 'neutral' | 'info'> = {
  Unpaid: 'danger',
  'Partially settled': 'warning',
  Settled: 'success',
};

export function AgentStatementClient({
  rows,
  filters,
  initialFilter,
  localCurrency,
  agentFirstName,
}: {
  rows: StatementRow[];
  filters: Record<string, string>;
  initialFilter: string;
  localCurrency: string;
  agentFirstName: string;
}) {
  const [filter, setFilter] = React.useState(initialFilter);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const money = (value: number) =>
    `${localCurrency} ${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (value: number) => (Math.abs(value) < 0.005 ? '—' : `${value > 0 ? '+' : '−'} ${money(value)}`);
  const position = (value: number) =>
    Math.abs(value) < 0.005
      ? 'Nothing either way'
      : value > 0
        ? `${agentFirstName} owes FID ${money(value)}`
        : `FID owes ${agentFirstName} ${money(value)}`;

  const inRange = (r: StatementRow) => (!from || r.dateIso >= from) && (!to || r.dateIso <= to);
  const shown = rows.filter((r) => r.filters.includes(filter) && inRange(r));

  // Opening and closing position over the whole relationship, for the dates chosen.
  const before = rows.filter((r) => from && r.dateIso < from);
  const opening = before.length ? before[before.length - 1].runningNet : 0;
  const inPeriod = rows.filter(inRange);
  const closing = inPeriod.length ? inPeriod[inPeriod.length - 1].runningNet : opening;

  const columns: DataColumn<StatementRow>[] = [
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      exportValue: (r) => r.date,
      cell: (r) => <span className="whitespace-nowrap">{r.date}</span>,
    },
    {
      id: 'reference',
      header: 'Reference',
      exportValue: (r) => [r.documentNumber, r.journalNumber].filter(Boolean).join(' · '),
      cell: (r) => (
        <span className="whitespace-nowrap text-xs">
          {r.documentNumber ? <span className="block font-medium">{r.documentNumber}</span> : null}
          <span className="block text-ink-subtle">{r.journalNumber}</span>
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Transaction',
      mobile: 'title',
      exportValue: (r) => r.typeLabel,
      cell: (r) => (
        <span className="text-sm font-medium" data-testid="agent-ledger-type">
          {r.typeLabel}
        </span>
      ),
    },
    {
      id: 'shipment',
      header: 'Shipment',
      hideable: true,
      exportValue: (r) => r.shipment?.reference ?? '',
      cell: (r) =>
        r.shipment ? (
          <Link href={`/shipments/${r.shipment.id}`} className="whitespace-nowrap text-xs font-medium text-forest-800 hover:text-gold-700">
            {r.shipment.reference}
          </Link>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      id: 'party',
      header: 'Customer / invoice',
      hideable: true,
      exportValue: (r) => [r.customerName, ...r.documents.map((d) => d.number)].filter(Boolean).join(' · '),
      cell: (r) => (
        <span className="text-xs">
          {r.customerName ?? (r.documents.length ? null : '—')}
          {r.documents.map((d) => (
            <Link key={d.id} href={`/sales/${d.id}`} className="block font-medium text-forest-800 hover:text-gold-700">
              {d.number}
            </Link>
          ))}
        </span>
      ),
    },
    {
      id: 'memo',
      header: 'Memo',
      hideable: true,
      exportValue: (r) => r.memo ?? '',
      cell: (r) => <span className="block max-w-56 text-xs text-ink-muted">{r.memo ?? '—'}</span>,
    },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      exportValue: (r) => r.amount,
      cell: (r) => <DualText primary={r.amount} equivalent={r.amountEquivalent} />,
    },
    {
      id: 'receivable',
      header: `${agentFirstName} owes FID`,
      numeric: true,
      exportValue: (r) => (Math.abs(r.receivableChange) < 0.005 ? '' : r.receivableChange.toFixed(2)),
      cell: (r) => <span className="tnum whitespace-nowrap text-xs">{signed(r.receivableChange)}</span>,
    },
    {
      id: 'payable',
      header: `FID owes ${agentFirstName}`,
      numeric: true,
      exportValue: (r) => (Math.abs(r.payableChange) < 0.005 ? '' : r.payableChange.toFixed(2)),
      cell: (r) => <span className="tnum whitespace-nowrap text-xs">{signed(r.payableChange)}</span>,
    },
    {
      id: 'running',
      header: 'Running position',
      numeric: true,
      exportValue: (r) => position(r.runningNet),
      cell: (r) => (
        <span className="tnum whitespace-nowrap text-xs font-medium" data-testid="agent-ledger-direction">
          {position(r.runningNet)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      exportValue: (r) => r.status,
      cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>,
    },
    {
      id: 'actions',
      header: '',
      mobile: 'action',
      printHidden: true,
      cell: (r) =>
        r.sourceHref ? (
          <Link href={r.sourceHref} className="text-xs font-medium text-forest-800 hover:text-gold-700">
            Open
          </Link>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface-sunken p-1" data-print="hide">
        {Object.entries(filters).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            data-testid={`agent-tab-${key.toLowerCase().replaceAll('_', '-')}`}
            aria-pressed={filter === key}
            className={
              filter === key
                ? 'rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow-sm'
                : 'rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink'
            }
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" className="w-40">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" className="w-40">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <dl className="ml-auto grid grid-cols-3 gap-4 text-xs" data-testid="agent-ledger-period">
          <div>
            <dt className="text-ink-muted">Opening position</dt>
            <dd className="tnum font-medium">{position(opening)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Movement</dt>
            <dd className="tnum font-medium">{signed(closing - opening)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Closing position</dt>
            <dd className="tnum font-semibold">{position(closing)}</dd>
          </div>
        </dl>
      </div>

      <div data-testid="agent-ledger">
        <DataTable
          data={shown}
          columns={columns}
          getRowId={(r) => r.id}
          pageSize={500}
          searchValue={(r) =>
            `${r.typeLabel} ${r.documentNumber ?? ''} ${r.journalNumber} ${r.shipment?.reference ?? ''} ${r.customerName ?? ''} ${r.memo ?? ''} ${r.documents.map((d) => d.number).join(' ')}`
          }
          searchPlaceholder="Search by reference, shipment, customer or memo…"
          filters={[
            { id: 'shipment', label: 'Shipment', value: (r) => r.shipment?.reference },
            { id: 'type', label: 'Transaction', value: (r) => r.typeLabel },
            { id: 'status', label: 'Status', value: (r) => r.status },
          ]}
          emptyTitle="Nothing here yet"
          emptyDescription="A collection, a commission, a settlement or a loan with this agent will appear here."
          exportFileName="Agent Ledger"
          expandedContent={(r) => (
            <div className="space-y-3 px-4 py-3 text-xs">
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                <div>
                  <dt className="text-ink-muted">Journal</dt>
                  <dd className="font-medium">{r.journalNumber}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Source</dt>
                  <dd className="font-medium">
                    {r.sourceHref ? (
                      <Link href={r.sourceHref} className="text-forest-800 hover:text-gold-700">
                        {r.documentNumber ?? r.journalNumber}
                      </Link>
                    ) : (
                      (r.documentNumber ?? '—')
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Posted by</dt>
                  <dd className="font-medium">{r.createdBy ?? '—'}</dd>
                </div>
              </dl>
              <TableWrap className="shadow-none">
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Account</TH>
                      <TH>Which balance</TH>
                      <TH numeric>Debit</TH>
                      <TH numeric>Credit</TH>
                      <TH numeric>Debit {localCurrency}</TH>
                      <TH numeric>Credit {localCurrency}</TH>
                      <TH numeric>FX</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {r.lines.map((l, i) => (
                      <TR key={`${r.id}-${i}`}>
                        <TD>{l.account}</TD>
                        <TD className="text-ink-muted">{l.kind}</TD>
                        <TD numeric>{l.debit}</TD>
                        <TD numeric>{l.credit}</TD>
                        <TD numeric className="text-ink-muted">{l.debitLocal}</TD>
                        <TD numeric className="text-ink-muted">{l.creditLocal}</TD>
                        <TD numeric className="text-ink-muted">{l.rate ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
              <p className="text-ink-subtle">
                Only the lines on {agentFirstName}&rsquo;s own balances are shown; the other side of the entry (cash, bank, stock,
                costs) is on the journal.
              </p>
            </div>
          )}
        />
      </div>
    </div>
  );
}
