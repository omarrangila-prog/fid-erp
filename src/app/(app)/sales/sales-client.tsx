'use client';

import * as React from 'react';
import Link from 'next/link';
import { shortDocumentNumber } from '@/lib/short-number';
import { Plus } from 'lucide-react';
import { DualText } from '@/components/shared/dual-text';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';
import { HandCoins, BookOpen, Printer } from 'lucide-react';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import { deleteSalesInvoiceAction } from '@/server/actions/trading-actions';
import { cn } from '@/lib/utils';

export type SaleRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceDateSort: number;
  dueDate: string;
  dueDateSort: number;
  customerName: string;
  customerId: string;
  currency: string;
  totalAmount: string;
  totalAmountSort: number;
  totalAmountUsd: string;
  quantityLabel: string;
  quantitySort: number;
  paidLabel: string;
  outstandingLabel: string;
  totalRaw: number;
  paidRaw: number;
  /** Credit notes against the invoice, shown under Paid — not money received. */
  creditedLabel: string | null;
  outstandingRaw: number;
  invoiceDateIso: string;
  totalEquivalent: { text: string; title: string } | null;
  paidEquivalent: { text: string; title: string } | null;
  outstandingEquivalent: { text: string; title: string } | null;
  /** The same two in dollars, so invoices in different currencies can be totalled. */
  paidUsdSort: number;
  outstandingUsdSort: number;
  settlement: string;
  daysOverdue: number;
  status: string;
  paymentType: string;
  createdBy: string;
  items: string;
  itemCount: number;
  jobNumber: string | null;
  /** The ICUL/FID order(s) the invoice's stock came from, summarised from its lines. */
  reference: string | null;
  references: string[];
  /** Each line with its own source, for the expanded view. */
  lineSources: Array<{ reference: string; itemName: string; batchNumber: string; warehouseName: string; quantityLabel: string }>;
  shipmentId: string | null;
  warehouseNames: string;
};

export function SalesClient({
  rows,
  canCreate,
  canEdit,
  canDelete,
  canReverse,
  canApprove,
  initialStanding = null,
}: {
  rows: SaleRow[];
  initialStanding?: 'PAID' | 'PARTIAL' | 'UNPAID' | 'OUTSTANDING' | null;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canApprove: boolean;
}) {
  /*
   * Where the money stands, and a way into it.
   *
   * The question a trader asks first is how much is still owed and by whom,
   * and the answer used to mean reading down a column of invoices. These say
   * it at the top, and each one opens the invoices behind it: the figure and
   * the list are the same thing, so a total can never point at nothing.
   */
  const [standing, setStanding] = React.useState<'PAID' | 'PARTIAL' | 'UNPAID' | 'OUTSTANDING' | null>(initialStanding);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const posted = rows.filter((row) => row.status === 'POSTED');
  const summarise = (settlement: 'PAID' | 'PARTIAL' | 'UNPAID' | 'OUTSTANDING') => {
    // Outstanding is unpaid and partly paid together: a part payment still leaves money owed.
    const matching = posted.filter((row) =>
      settlement === 'OUTSTANDING' ? row.settlement !== 'PAID' : row.settlement === settlement,
    );
    return {
      settlement,
      count: matching.length,
      paidUsd: matching.reduce((total, row) => total + row.paidUsdSort, 0),
      outstandingUsd: matching.reduce((total, row) => total + row.outstandingUsdSort, 0),
    };
  };
  const standings = [
    {
      ...summarise('OUTSTANDING'),
      label: 'Outstanding',
      hint: 'Unpaid and partly paid — what customers still owe',
      amount: 'outstanding' as const,
    },
    { ...summarise('PAID'), label: 'Paid', hint: 'Settled in full', amount: 'paid' as const },
    { ...summarise('PARTIAL'), label: 'Partly paid', hint: 'Something received, something still owed', amount: 'outstanding' as const },
    { ...summarise('UNPAID'), label: 'Unpaid', hint: 'Nothing received yet', amount: 'outstanding' as const },
  ];
  const money = (value: number) =>
    `USD ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // A deleted invoice is not on this list at all: the page only loads live
  // documents. Its journal and the trail of who deleted it stay in the books
  // and the audit log, where an accountant can find them.
  const inDates = (row: SaleRow) => (!from || row.invoiceDateIso >= from) && (!to || row.invoiceDateIso <= to);
  const visible = (
    standing
      ? rows.filter(
          (row) =>
            row.status === 'POSTED' &&
            (standing === 'OUTSTANDING' ? row.settlement !== 'PAID' : row.settlement === standing),
        )
      : rows
  ).filter(inDates);

  /*
   * By customer: what was invoiced, received and is still owed across the
   * invoices on screen, each in the invoices' own currency — a customer
   * billed in dirhams and in dollars gets a line for each.
   */
  const byCustomer = [...visible
    .filter((row) => row.status === 'POSTED')
    .reduce((map, row) => {
      const key = `${row.customerId}|${row.currency}`;
      const entry = map.get(key) ?? { customerId: row.customerId, customerName: row.customerName, currency: row.currency, count: 0, invoiced: 0, received: 0, outstanding: 0 };
      entry.count += 1;
      entry.invoiced += row.totalRaw;
      entry.received += row.paidRaw;
      entry.outstanding += row.outstandingRaw;
      map.set(key, entry);
      return map;
    }, new Map<string, { customerId: string; customerName: string; currency: string; count: number; invoiced: number; received: number; outstanding: number }>())
    .values()].sort((a, b) => b.outstanding - a.outstanding);
  const amount = (value: number, currency: string) =>
    `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const columns: DataColumn<SaleRow>[] = [
    /* The order the client reads a sales list in: when, which invoice, which
       order it came from, who it went to, where it stands, when it is due,
       how much, how much is left, and out of which warehouse. */
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.invoiceDateSort, cell: (r) => r.invoiceDate },
    {
      id: 'number',
      header: 'Invoice #',
      mobile: 'title',
      sortValue: (r) => r.invoiceNumber,
      exportValue: (r) => shortDocumentNumber(r.invoiceNumber),
      // INV 8, not FID-MA-SI-000008. The full number stays in the database,
      // on the printed tax invoice where the law wants it, and in search.
      cell: (r) => <span className="tnum font-medium">{shortDocumentNumber(r.invoiceNumber)}</span>,
    },
    {
      id: 'order',
      header: 'ICUL/FID Ref',
      mobile: 'meta',
      sortValue: (r) => r.reference ?? '',
      exportValue: (r) => r.references.join(', '),
      cell: (r) => <span className="text-xs font-medium text-forest-800">{r.reference ?? '—'}</span>,
    },
    {
      id: 'customer',
      header: 'Customer',
      mobile: 'meta',
      sortValue: (r) => r.customerName,
      cell: (r) => <span className="font-medium">{r.customerName}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      id: 'due',
      header: 'Due',
      hideable: true,
      sortValue: (r) => r.dueDateSort,
      cell: (r) => (
        <span>
          <span className="block">{r.dueDate}</span>
          {r.daysOverdue > 0 && r.settlement !== 'PAID' ? (
            <span className="block text-xs font-medium text-red-600">{r.daysOverdue}d overdue</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'value',
      header: 'Invoice total',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.totalAmountSort,
      cell: (r) => (
        <span>
          <DualText primary={r.totalAmount} equivalent={r.totalEquivalent} />
        </span>
      ),
    },
    {
      id: 'paid',
      header: 'Paid',
      numeric: true,
      hideable: true,
      cell: (r) =>
        r.paidLabel === '—' ? (
          '—'
        ) : (
          <span>
            <DualText primary={r.paidLabel} equivalent={r.paidEquivalent} />
            {r.creditedLabel ? <span className="block text-[11px] text-ink-subtle">+ credit note {r.creditedLabel}</span> : null}
          </span>
        ),
    },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      hideable: true,
      cell: (r) => (r.outstandingLabel === '—' ? '—' : <DualText primary={r.outstandingLabel} equivalent={r.outstandingEquivalent} />),
    },
    {
      id: 'warehouse',
      header: 'Location',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    {
      id: 'items',
      header: 'Items',
      mobile: 'meta',
      hideable: true,
      sortValue: (r) => r.items,
      exportValue: (r) => r.items,
      cell: (r) => (
        <span className="block max-w-56 truncate" title={r.items}>
          {r.items || '—'}
          {r.itemCount > 1 ? <span className="ml-1 text-xs text-ink-subtle">({r.itemCount})</span> : null}
        </span>
      ),
    },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => r.quantityLabel,
    },
    {
      id: 'settlement',
      header: 'Payment',
      hideable: true,
      sortValue: (r) => r.settlement,
      cell: (r) =>
        r.status === 'POSTED' ? (
          <StatusBadge status={r.settlement} meta={SETTLEMENT_STATUS_META} />
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      id: 'job',
      header: 'Job',
      hideable: true,
      defaultHidden: true,
      cell: (r) =>
        r.shipmentId ? (
          <Link href={`/shipments/${r.shipmentId}`} className="text-gold-700 hover:underline">
            {r.reference ?? '—'}
          </Link>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
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
      id: 'createdBy',
      header: 'Created by',
      hideable: true,
      defaultHidden: true,
      sortValue: (r) => r.createdBy,
      exportValue: (r) => r.createdBy,
      cell: (r) => <span className="text-xs text-ink-muted">{r.createdBy}</span>,
    },
    ...(canEdit || canDelete || canReverse || canApprove
      ? [
          {
            id: 'actions',
            header: 'Actions',
            printHidden: true,
            mobile: 'action' as const,
            pin: 'right' as const,
            cell: (r: SaleRow) => (
              <RowActions
                actions={[
                  viewAction(`/sales/${r.id}`),
                  editAction(`/sales/${r.id}/edit`, canEdit && r.status !== 'REVERSED'),
                  {
                    label: 'Record payment',
                    href: `/finance/receipts/new?invoice=${r.id}`,
                    icon: HandCoins,
                    show: r.status === 'POSTED' && r.settlement !== 'PAID',
                  },
                  { label: 'Customer ledger', href: `/ledgers/customers?customer=${r.customerId}`, icon: BookOpen },
                  { label: 'Print', href: `/sales/${r.id}/print`, icon: Printer },
                ]}
                destructive={{
                  status: r.status,
                  noun: 'invoice',
                  show: r.status === 'DRAFT' ? canDelete : canReverse,
                  cancelLabel: 'Delete invoice',
                  description:
                    'Stock returns to the warehouse it left and the customer balance and ledger are put back as they were. The invoice disappears from every list and total. The audit log keeps a record of who deleted it and why.',
                  run: (reason) => deleteSalesInvoiceAction(r.id, reason).then((res) => ({ ok: res.ok, error: res.ok ? undefined : res.error })),
                }}
              />
            ),
          } satisfies DataColumn<SaleRow>,
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="invoice-standing">
        {standings.map((card) => {
          const active = standing === card.settlement;
          const figure = card.amount === 'paid' ? card.paidUsd : card.outstandingUsd;
          return (
            <button
              key={card.settlement}
              type="button"
              onClick={() => setStanding(active ? null : card.settlement)}
              aria-pressed={active}
              data-testid={`invoice-standing-${card.settlement.toLowerCase()}`}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                active
                  ? 'border-forest-500 bg-forest-50/60'
                  : 'border-line bg-surface hover:border-forest-300',
              )}
            >
              <p className="text-xs font-medium text-ink-muted">{card.label}</p>
              <p className="tnum mt-1 text-xl font-semibold text-ink">{money(figure)}</p>
              <p className="mt-0.5 text-xs text-ink-subtle">
                {card.count === 1 ? '1 invoice' : `${card.count} invoices`} ·{' '}
                {card.amount === 'paid' ? 'received' : 'still owed'}
              </p>
              <p className="mt-1 text-[11px] text-ink-subtle">{active ? 'Showing these — click to clear' : card.hint}</p>
            </button>
          );
        })}
      </div>

      {standing ? (
        <p className="text-xs text-ink-muted" data-testid="invoice-standing-active">
          Showing {visible.length === 1 ? 'the 1 invoice' : `the ${visible.length} invoices`} that are{' '}
          {standing === 'OUTSTANDING'
            ? 'outstanding (unpaid or partly paid)'
            : (SETTLEMENT_STATUS_META[standing]?.label.toLowerCase() ?? standing.toLowerCase())}
          .{' '}
          <button type="button" onClick={() => setStanding(null)} className="underline underline-offset-2 hover:text-ink">
            Show every invoice
          </button>
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3" data-print="hide">
        <label className="text-xs text-ink-muted">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Invoices from"
          />
        </label>
        <label className="text-xs text-ink-muted">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 block h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Invoices to"
          />
        </label>
      </div>

      {byCustomer.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface" open={standing === 'OUTSTANDING'} data-testid="sales-by-customer">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">
            By customer — invoiced, received and still owed
          </summary>
          {/* A grid, not a table: the invoice list below stays the one table on the page. */}
          <div className="overflow-x-auto border-t border-line text-sm" role="list">
            <div className="grid min-w-[36rem] grid-cols-[2fr_repeat(4,1fr)] gap-x-4 px-4 py-2 text-xs font-medium text-ink-muted">
              <span>Customer</span>
              <span className="text-right">Invoices</span>
              <span className="text-right">Invoiced</span>
              <span className="text-right">Received</span>
              <span className="text-right">Outstanding</span>
            </div>
            {byCustomer.map((c) => (
              <div
                key={`${c.customerId}-${c.currency}`}
                role="listitem"
                className="grid min-w-[36rem] grid-cols-[2fr_repeat(4,1fr)] gap-x-4 border-t border-line px-4 py-2"
              >
                <a href={`/ledgers/customers/${c.customerId}`} className="font-medium text-forest-800 hover:text-gold-700">
                  {c.customerName}
                </a>
                <span className="tnum text-right">{c.count}</span>
                <span className="tnum text-right">{amount(c.invoiced, c.currency)}</span>
                <span className="tnum text-right">{amount(c.received, c.currency)}</span>
                <span className="tnum text-right font-semibold">{amount(c.outstanding, c.currency)}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <DataTable
      prefsKey="sales"
      data={visible}
      filters={[
      { id: 'status', label: 'Status', value: (r) => r.status },
      { id: 'settlement', label: 'Payment', value: (r) => r.settlement },
      { id: 'customer', label: 'Customer', value: (r) => r.customerName },
      { id: 'currency', label: 'Currency', value: (r) => r.currency },
      { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouseNames || null },
      ]}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/sales/${r.id}`}
      searchValue={(r) => `${r.invoiceNumber} ${r.customerName} ${r.jobNumber ?? ''} ${r.warehouseNames} ${r.references.join(' ')} ${r.items}`}
      expandedContent={(r) =>
        r.lineSources.length > 1 || r.references.length > 1 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 pr-3 font-medium">ICUL/FID Reference</th>
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 font-medium">Batch</th>
                <th className="py-1 pr-3 font-medium">Warehouse</th>
                <th className="py-1 text-right font-medium">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {r.lineSources.map((line, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="py-1 pr-3 font-medium text-forest-800">{line.reference}</td>
                  <td className="py-1 pr-3">{line.itemName}</td>
                  <td className="py-1 pr-3">{line.batchNumber}</td>
                  <td className="py-1 pr-3">{line.warehouseName}</td>
                  <td className="tnum py-1 text-right">{line.quantityLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null
      }
      searchPlaceholder="Search by invoice, customer or job…"
      emptyTitle="No sales invoices yet"
      emptyDescription="Sell coffee from a batch in a warehouse. Posting raises the receivable and relieves the stock."
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/sales/new">
              <Plus />
              New invoice
            </Link>
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          {canCreate ? (
            <Button asChild>
              <Link href="/sales/new">
                <Plus />
                <span className="hidden sm:inline">New invoice</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : null}
        </>
      }
      />
    </div>
  );
}

export { Badge };
