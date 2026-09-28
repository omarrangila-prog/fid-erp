'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, LayoutList, RotateCcw, Rows3, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dec, type Decimal } from '@/lib/money';
import { formatDate, formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { PrintButton } from '@/components/shared/print-button';
import {
  CORE_LEDGER_COLUMNS,
  DEFAULT_LEDGER_PREFS,
  LEDGER_COLUMN_LABEL,
  LEDGER_PAGE_SIZES,
  normaliseLedgerPrefs,
  type LedgerColumnKey,
  type LedgerPrefs,
  type LedgerReportKey,
} from '@/lib/ledger-columns';
import { saveLedgerPrefsAction } from '@/server/actions/ledger-prefs-actions';
import type { LedgerWindow } from '@/lib/ledger-window';
import { ShareDialog, ShareTrigger, WhatsAppIcon, type ShareChoice, type ShareSpec } from '@/components/share/share-dialog';
import { shareReportLabel, type ShareReportKey, type ShareSection } from '@/lib/share/model';

const SHARE_REPORT: Record<LedgerReportKey, ShareReportKey> = {
  customer: 'customer-ledger',
  supplier: 'supplier-ledger',
  agent: 'agent-ledger',
  'cash-bank': 'cash-bank-ledger',
  'general-ledger': 'general-ledger',
  'unpaid-expenses': 'unpaid-expenses',
};

/**
 * Every ledger in the system, drawn the same way.
 *
 * Customer, supplier, agent, cash and bank, general ledger, unpaid expenses:
 * one accounting report — Date, Memo, Debit, Credit, Balance — with strong
 * grid lines like a spreadsheet, the opening balance above the rows and the
 * totals and closing balance below. Anything else (reference, JV number,
 * shipment, invoice, who entered it) is a column the reader switches on,
 * and the arrangement is remembered for that person and that ledger.
 *
 * On a phone the table scrolls sideways under a sticky header with the date
 * pinned, or switches to one bordered card per row. Printing uses its own
 * table — every filtered row, not just the page on screen — in the columns
 * chosen, on A4.
 *
 * Amounts arrive as decimal strings in the ledger's currency, with the
 * running balance already worked out on the server; filtering by date only
 * picks the balance before and after, and totals are summed as decimals, so
 * nothing here is floating-point arithmetic.
 */

export type LedgerReportRow = {
  key: string;
  /** yyyy-mm-dd */
  date: string;
  reference?: string | null;
  referenceHref?: string | null;
  jv?: string | null;
  type?: string | null;
  memo?: string | null;
  /** A second line under the memo — who collected it, what it settles. */
  memoNote?: string | null;
  shipment?: { label: string; href?: string | null } | null;
  invoices?: Array<{ label: string; href: string }>;
  party?: string | null;
  currency?: string | null;
  status?: string | null;
  createdBy?: string | null;
  /** Quick-filter groups this row belongs to. */
  tags?: string[];
  debit: string;
  credit: string;
  /** Running balance after this row; positive means the ledger's normal side. */
  balance: string;
  actions?: React.ReactNode;
  /** Shown when the row is opened: the full memo, accounts, audit. */
  details?: React.ReactNode;
  /** More facts for the opened row — the amount in its own currency, its equivalent. */
  facts?: Array<{ label: string; value: string }>;
};

export type LedgerReportProps = {
  report: LedgerReportKey;
  /** "Customer ledger", "Agent ledger"… */
  title: string;
  /** The party or account. */
  subject: string;
  currency: string;
  /** Which side a positive balance is on, for Dr/Cr. */
  balanceSide: 'debit' | 'credit';
  /** The balance before the first row given. */
  opening: string;
  rows: LedgerReportRow[];
  /** The optional columns this ledger has data for. */
  available: LedgerColumnKey[];
  initialPrefs: LedgerPrefs;
  companyName: string;
  /** Dates already applied on the server, for the printed heading. */
  periodLabel?: string;
  /** Offer From/To on the component itself (off where the page filters dates on the server). */
  dateFilter?: boolean;
  quickFilters?: Array<{ key: string; label: string }>;
  initialQuickFilter?: string;
  /** Page-specific controls in the toolbar, e.g. the currency switch. */
  toolbar?: React.ReactNode;
  emptyText?: string;
  /** 'document': just the ledger table, on screen and on paper — for a statement page with its own letterhead. */
  mode?: 'interactive' | 'document';
  /**
   * The rows were cut on the server (see windowLedger): its figures for the
   * whole period, and the From/To it applied. Dates are then chosen through
   * the page address, so earlier entries come from the server, not the phone.
   */
  window?: LedgerWindow;
};

const NIL = dec(0);

// Whether the screen is phone-sized, read the same way on every render and
// updated when it changes; the server renders the desktop layout.
const PHONE_QUERY = '(max-width: 639px)';
function subscribePhone(listener: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
function usePhone(): boolean {
  return React.useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

function Money({ value, currency }: { value: Decimal; currency: string }) {
  return value.isZero() ? <span className="text-ink-subtle">—</span> : <>{formatMoney(value, currency)}</>;
}

export function LedgerReport(props: LedgerReportProps) {
  const {
    report,
    title,
    subject,
    currency,
    balanceSide,
    rows,
    available,
    companyName,
    periodLabel,
    dateFilter = true,
    quickFilters,
    toolbar,
    emptyText = 'Nothing has been posted to this ledger yet.',
  } = props;

  const [prefs, setPrefs] = React.useState<LedgerPrefs>(() => ({
    ...normaliseLedgerPrefs(props.initialPrefs, available),
    saved: props.initialPrefs.saved,
  }));
  const serverWindow = props.window;
  const [from, setFrom] = React.useState(serverWindow?.from ?? '');
  const [to, setTo] = React.useState(serverWindow?.to ?? '');
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('');
  const [rowCurrency, setRowCurrency] = React.useState('');
  const [shipment, setShipment] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [quick, setQuick] = React.useState(props.initialQuickFilter ?? quickFilters?.[0]?.key ?? '');
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);
  const [customizing, setCustomizing] = React.useState(false);
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [share, setShare] = React.useState<{ id: number; spec: ShareSpec } | null>(null);
  const router = useRouter();

  const balanceText = (value: Decimal) => {
    if (value.abs().lessThan('0.005')) return formatMoney(0, currency);
    const debitSide = balanceSide === 'debit' ? value.isPositive() : value.isNegative();
    return `${formatMoney(value.abs(), currency)} ${debitSide ? 'Dr' : 'Cr'}`;
  };

  // --- The numbers, for the dates chosen ----------------------------------
  const opening = dec(props.opening);
  // Dates the server already applied are not applied again here.
  const clientFrom = serverWindow ? '' : from;
  const clientTo = serverWindow ? '' : to;
  const before = clientFrom ? rows.filter((r) => r.date < clientFrom) : [];
  const periodOpening = serverWindow
    ? dec(serverWindow.opening)
    : before.length
      ? dec(before[before.length - 1].balance)
      : opening;
  const inPeriod = rows.filter((r) => (!clientFrom || r.date >= clientFrom) && (!clientTo || r.date <= clientTo));
  const periodClosing = serverWindow
    ? dec(serverWindow.closing)
    : inPeriod.length
      ? dec(inPeriod[inPeriod.length - 1].balance)
      : clientTo
        ? (() => {
            const upTo = rows.filter((r) => r.date <= clientTo);
            return upTo.length ? dec(upTo[upTo.length - 1].balance) : periodOpening;
          })()
        : periodOpening;
  /** The balance just before the first row on screen: the period's opening, or what earlier rows bring forward. */
  const firstBalance = serverWindow?.trimmed ? opening : periodOpening;
  const broughtForward = serverWindow?.trimmed ? 'Brought forward' : 'Opening balance';

  const needle = search.trim().toLowerCase();
  const shown = inPeriod.filter(
    (r) =>
      (!quick || !quickFilters?.length || quick === quickFilters[0].key || (r.tags ?? []).includes(quick)) &&
      (!type || r.type === type) &&
      (!rowCurrency || r.currency === rowCurrency) &&
      (!shipment || r.shipment?.label === shipment) &&
      (!status || r.status === status) &&
      (!needle ||
        [r.memo, r.memoNote, r.reference, r.jv, r.type, r.party, r.shipment?.label, ...(r.invoices ?? []).map((i) => i.label)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  );
  const narrowed = shown.length !== inPeriod.length;
  // The whole period's totals when nothing narrows it; otherwise the rows shown.
  const totalDebit = serverWindow && !narrowed ? dec(serverWindow.totalDebit) : shown.reduce((t, r) => t.plus(dec(r.debit)), NIL);
  const totalCredit = serverWindow && !narrowed ? dec(serverWindow.totalCredit) : shown.reduce((t, r) => t.plus(dec(r.credit)), NIL);

  /** From/To on a windowed ledger: the server brings the rows for the new dates. */
  const goToDates = (nextFrom: string, nextTo: string) => {
    const params = new URLSearchParams(window.location.search);
    if (nextFrom) params.set('from', nextFrom);
    else params.delete('from');
    if (nextTo) params.set('to', nextTo);
    else params.delete('to');
    const query = params.toString();
    router.push(query ? `${window.location.pathname}?${query}` : window.location.pathname);
  };

  const pages = Math.max(1, Math.ceil(shown.length / prefs.pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = shown.slice(current * prefs.pageSize, (current + 1) * prefs.pageSize);

  const distinct = (pick: (r: LedgerReportRow) => string | null | undefined) =>
    [...new Set(rows.map(pick).filter((v): v is string => Boolean(v)))].sort();
  const types = distinct((r) => r.type);
  const currencies = distinct((r) => r.currency);
  const shipments = distinct((r) => r.shipment?.label);
  const statuses = distinct((r) => r.status);

  const phone = usePhone();
  // A phone shows Date, Memo, Debit, Credit, Balance until the reader saves a
  // layout of their own; paper always gets the chosen columns.
  const printColumns = prefs.columns;
  const columns = phone && !prefs.saved ? prefs.columns.filter((c) => c !== 'reference') : prefs.columns;
  const resetPage = () => setPage(0);

  // --- Cells ----------------------------------------------------------------
  const cell = (key: LedgerColumnKey, r: LedgerReportRow, printing = false): React.ReactNode => {
    switch (key) {
      case 'date':
        return formatDate(new Date(`${r.date}T00:00:00.000Z`));
      case 'reference':
        return r.reference ? (
          r.referenceHref && !printing ? (
            <Link href={r.referenceHref} className="font-medium text-forest-800 hover:text-gold-700" onClick={(e) => e.stopPropagation()}>
              {r.reference}
            </Link>
          ) : (
            r.reference
          )
        ) : (
          '—'
        );
      case 'jv':
        return r.jv ?? '—';
      case 'type':
        return r.type ?? '—';
      case 'memo':
        return (
          <span className={cn('block', printing ? '' : 'line-clamp-2')} title={[r.memo, r.memoNote].filter(Boolean).join(' — ') || undefined}>
            {r.memo || r.type || '—'}
            {r.memoNote ? <span className="block text-[11px] text-ink-muted">{r.memoNote}</span> : null}
          </span>
        );
      case 'shipment':
        return r.shipment ? (
          printing || !r.shipment.href ? (
            r.shipment.label
          ) : (
            <Link href={r.shipment.href} className="font-medium text-forest-800 hover:text-gold-700" onClick={(e) => e.stopPropagation()}>
              {r.shipment.label}
            </Link>
          )
        ) : (
          '—'
        );
      case 'invoice':
        return r.invoices?.length
          ? r.invoices.map((inv, i) => (
              <span key={inv.href}>
                {i > 0 ? ', ' : ''}
                {printing ? (
                  inv.label
                ) : (
                  <Link href={inv.href} className="font-medium text-forest-800 hover:text-gold-700" onClick={(e) => e.stopPropagation()}>
                    {inv.label}
                  </Link>
                )}
              </span>
            ))
          : '—';
      case 'party':
        return r.party ?? '—';
      case 'currency':
        return r.currency ?? currency;
      case 'status':
        return r.status ?? '—';
      case 'createdBy':
        return r.createdBy ?? '—';
      case 'debit':
        return <Money value={dec(r.debit)} currency={currency} />;
      case 'credit':
        return <Money value={dec(r.credit)} currency={currency} />;
      case 'balance':
        return balanceText(dec(r.balance));
    }
  };

  const numeric = (key: LedgerColumnKey) => key === 'debit' || key === 'credit' || key === 'balance';
  const cellClass = (key: LedgerColumnKey) =>
    cn(
      numeric(key) ? 'tnum whitespace-nowrap text-right' : key === 'memo' ? 'min-w-[10rem] max-w-[26rem] sm:min-w-[12rem]' : 'whitespace-nowrap',
      key === 'balance' && 'font-semibold',
      key === 'date' && 'ledger-sticky-col',
    );
  const hasDetails = rows.some((r) => r.details || r.actions || r.facts?.length);

  /** The row of figures under a heading: opening, totals, closing — placed under the right columns. */
  const figuresRow = (label: string, figures: Partial<Record<LedgerColumnKey, React.ReactNode>>, className: string, printing = false) => {
    const cols = printing ? printColumns : columns;
    const first = cols.findIndex((c) => figures[c] !== undefined);
    const lead = first < 0 ? cols.length : first;
    return (
      <tr className={className}>
        {selecting && !printing ? <td data-print="hide" /> : null}
        {/* The label stays readable while the figures scroll, without covering them. */}
        <td colSpan={Math.max(1, lead)} className="font-semibold">
          <span className={cn('inline-block whitespace-nowrap', !printing && 'sticky left-3')}>{label}</span>
        </td>
        {cols.slice(Math.max(1, lead)).map((c) => (
          <td key={c} className={cellClass(c).replace('ledger-sticky-col', '')}>
            {figures[c] ?? ''}
          </td>
        ))}
        {hasDetails && !printing ? <td data-print="hide" /> : null}
      </tr>
    );
  };

  const summary = (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink/70 bg-ink/70 text-xs sm:grid-cols-4" data-testid="ledger-summary">
      {(
        [
          ['Opening balance', balanceText(periodOpening)],
          [narrowed ? 'Debit (shown)' : 'Total debit', formatMoney(totalDebit, currency)],
          [narrowed ? 'Credit (shown)' : 'Total credit', formatMoney(totalCredit, currency)],
          ['Closing balance', balanceText(periodClosing)],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="bg-surface px-3 py-2">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="tnum text-sm font-semibold text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );

  const period =
    from || to ? `${from ? formatDate(new Date(`${from}T00:00:00Z`)) : 'the start'} – ${to ? formatDate(new Date(`${to}T00:00:00Z`)) : 'today'}` : (periodLabel ?? 'All dates');

  // --- Sharing: the same rows, columns and figures, as text --------------------
  const cellText = (key: LedgerColumnKey, r: LedgerReportRow): string => {
    switch (key) {
      case 'date':
        return formatDate(new Date(`${r.date}T00:00:00.000Z`));
      case 'memo':
        return [r.memo || r.type || '—', r.memoNote].filter(Boolean).join('\n');
      case 'shipment':
        return r.shipment?.label ?? '—';
      case 'invoice':
        return r.invoices?.map((i) => i.label).join(', ') || '—';
      case 'currency':
        return r.currency ?? currency;
      case 'debit':
      case 'credit': {
        const value = dec(key === 'debit' ? r.debit : r.credit);
        return value.isZero() ? '—' : formatMoney(value, currency);
      }
      case 'balance':
        return balanceText(dec(r.balance));
      default:
        return r[key] ?? '—';
    }
  };

  /** The balance just before a row, from the running balances the server worked out. */
  const balanceBefore = (row: LedgerReportRow | undefined, fallback: Decimal) => {
    if (!row) return fallback;
    const index = rows.findIndex((x) => x.key === row.key);
    return index > 0 ? dec(rows[index - 1].balance) : opening;
  };

  const openShare = (scope?: string) => {
    const offered = [...new Set<LedgerColumnKey>([...prefs.columns, ...CORE_LEDGER_COLUMNS, ...available])];
    const filterWords = [
      quickFilters?.length && quick && quick !== quickFilters[0].key ? (quickFilters.find((f) => f.key === quick)?.label ?? null) : null,
      needle ? `Search: ${search.trim()}` : null,
      type ? `Type: ${type}` : null,
      rowCurrency ? `Currency: ${rowCurrency}` : null,
      shipment ? `Shipment: ${shipment}` : null,
      status ? `Status: ${status}` : null,
    ].filter((w): w is string => Boolean(w));
    const sum = (list: LedgerReportRow[], side: 'debit' | 'credit') => list.reduce((t, r) => t.plus(dec(r[side])), NIL);
    const first = current * prefs.pageSize + 1;

    const spec: ShareSpec = {
      report: SHARE_REPORT[report],
      title: shareReportLabel(SHARE_REPORT[report]),
      subject,
      period,
      scopes: [
        { key: 'filtered', label: narrowed ? `Current filtered report (${shown.length} rows)` : `Current report (${shown.length} rows)`, hint: 'Exactly what the table shows, every page of it.' },
        ...(pages > 1 ? [{ key: 'view', label: `Current page only (rows ${first}–${first + pageRows.length - 1})` }] : []),
        ...(narrowed ? [{ key: 'all', label: `Full period, without the filters (${inPeriod.length} rows)` }] : []),
        ...(inPeriod.length > 1 ? [{ key: 'range', label: 'A date range', hint: 'Within the dates loaded on this page.' }] : []),
        ...(selected.size ? [{ key: 'selected', label: `Selected rows (${selected.size})` }] : []),
      ],
      defaultScope: scope ?? 'filtered',
      columns: offered.map((c) => ({ key: c, label: LEDGER_COLUMN_LABEL[c], checked: prefs.columns.includes(c) })),
      extras: [
        { key: 'opening', label: 'Opening balance', checked: true },
        { key: 'closing', label: 'Closing balance', checked: true },
        { key: 'totals', label: 'Totals', checked: true },
      ],
      dateRange: { min: inPeriod[0]?.date, max: inPeriod[inPeriod.length - 1]?.date },
      onChooseRows: () => {
        setSelecting(true);
        setPrefs((p) => ({ ...p, view: 'table' }));
      },
      build: (choice: ShareChoice) => {
        let list: LedgerReportRow[];
        let openBal = firstBalance;
        let close = periodClosing;
        let debit = totalDebit;
        let credit = totalCredit;
        let openingLabel = broughtForward;
        let scopeLabel = narrowed ? 'Current filtered report' : 'Current report';
        if (choice.scope === 'view') {
          list = pageRows;
          openBal = balanceBefore(list[0], firstBalance);
          close = list.length ? dec(list[list.length - 1].balance) : openBal;
          [debit, credit] = [sum(list, 'debit'), sum(list, 'credit')];
          openingLabel = 'Balance before these rows';
          scopeLabel = `Current page (rows ${first}–${first + list.length - 1})`;
        } else if (choice.scope === 'all') {
          list = inPeriod;
          if (!serverWindow) [debit, credit] = [sum(list, 'debit'), sum(list, 'credit')];
          else [debit, credit] = [dec(serverWindow.totalDebit), dec(serverWindow.totalCredit)];
          scopeLabel = 'Full period, without filters';
        } else if (choice.scope === 'range') {
          list = inPeriod.filter((r) => (!choice.from || r.date >= choice.from) && (!choice.to || r.date <= choice.to));
          const earlier = inPeriod.filter((r) => choice.from && r.date < choice.from);
          openBal = earlier.length ? dec(earlier[earlier.length - 1].balance) : balanceBefore(inPeriod[0], firstBalance);
          close = list.length ? dec(list[list.length - 1].balance) : openBal;
          [debit, credit] = [sum(list, 'debit'), sum(list, 'credit')];
          openingLabel = 'Opening balance';
          scopeLabel = 'Date range';
        } else if (choice.scope === 'selected') {
          list = shown.filter((r) => selected.has(r.key));
          openBal = balanceBefore(list[0], firstBalance);
          close = list.length ? dec(list[list.length - 1].balance) : openBal;
          [debit, credit] = [sum(list, 'debit'), sum(list, 'credit')];
          openingLabel = 'Balance before the first selected row';
          scopeLabel = `${list.length} selected row${list.length === 1 ? '' : 's'}`;
        } else {
          list = shown;
        }

        const cols = (choice.columns.length ? choice.columns : CORE_LEDGER_COLUMNS) as LedgerColumnKey[];
        const figure = (label: string, figures: Partial<Record<LedgerColumnKey, string>>, kind: 'opening' | 'total' | 'closing') => {
          const at = cols.findIndex((c) => figures[c] !== undefined);
          if (at < 0) return null;
          const lead = Math.max(1, at);
          return {
            kind,
            cells: [{ text: label, ...(lead > 1 ? { span: lead } : {}) }, ...cols.slice(lead).map((c) => ({ text: figures[c] ?? '' }))],
          };
        };
        const section: ShareSection = {
          columns: cols.map((c) => ({ label: LEDGER_COLUMN_LABEL[c], numeric: numeric(c) })),
          rows: [
            choice.extras.opening ? figure(openingLabel, { balance: balanceText(openBal) }, 'opening') : null,
            ...list.map((r) => ({ cells: cols.map((c) => ({ text: cellText(c, r) })) })),
            choice.extras.totals ? figure('Totals', { debit: formatMoney(debit, currency), credit: formatMoney(credit, currency) }, 'total') : null,
            choice.extras.closing ? figure('Closing balance', { balance: balanceText(close) }, 'closing') : null,
          ].filter((r): r is NonNullable<typeof r> => r !== null),
        };
        return {
          filters: filterWords,
          scopeLabel,
          facts: [
            ...(choice.extras.opening ? [{ label: openingLabel, value: balanceText(openBal) }] : []),
            ...(choice.extras.totals
              ? [
                  { label: 'Total debit', value: formatMoney(debit, currency) },
                  { label: 'Total credit', value: formatMoney(credit, currency) },
                ]
              : []),
            ...(choice.extras.closing ? [{ label: 'Closing balance', value: balanceText(close) }] : []),
          ],
          sections: [section],
        };
      },
    };
    setShare((s) => ({ id: (s?.id ?? 0) + 1, spec }));
  };

  const documentTable = (
    <table className="ledger-grid ledger-grid-print w-full">
      <thead>
        <tr>
          {printColumns.map((c) => (
            <th key={c} className={cellClass(c).replace('ledger-sticky-col', '')}>
              {LEDGER_COLUMN_LABEL[c]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {figuresRow(broughtForward, { balance: balanceText(firstBalance) }, 'ledger-opening', true)}
        {shown.map((r) => (
          <tr key={r.key}>
            {printColumns.map((c) => (
              <td key={c} className={cellClass(c).replace('ledger-sticky-col', '')}>
                {cell(c, r, true)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      <tfoot>
        {figuresRow('Total debit / credit', { debit: formatMoney(totalDebit, currency), credit: formatMoney(totalCredit, currency) }, 'ledger-totals', true)}
        {figuresRow('Closing balance', { balance: balanceText(periodClosing) }, 'ledger-closing', true)}
      </tfoot>
    </table>
  );

  if (props.mode === 'document') {
    return (
      // A document is laid out for A4; on a phone its table scrolls inside itself.
      <div className="ledger-document relative overflow-x-auto print:overflow-visible" data-testid="ledger-document">
        {documentTable}
      </div>
    );
  }

  return (
    <section className="space-y-3" data-testid="ledger-report" data-report={report}>
      {/* Controls: none of this prints. */}
      <div className="space-y-2" data-print="hide">
        {quickFilters?.length ? (
          <nav className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-1 sm:flex-wrap">
            {quickFilters.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={quick === f.key}
                data-testid={`ledger-quick-${f.key.toLowerCase().replaceAll('_', '-')}`}
                onClick={() => {
                  setQuick(f.key);
                  resetPage();
                }}
                className={
                  quick === f.key
                    ? 'shrink-0 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow-sm'
                    : 'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink'
                }
              >
                {f.label}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          {dateFilter ? (
            <>
              <label className="flex flex-col text-[11px] text-ink-muted">
                From
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    resetPage();
                    if (serverWindow) goToDates(e.target.value, to);
                  }}
                  className="h-9 w-36"
                  aria-label="From date"
                />
              </label>
              <label className="flex flex-col text-[11px] text-ink-muted">
                To
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    resetPage();
                    if (serverWindow) goToDates(from, e.target.value);
                  }}
                  className="h-9 w-36"
                  aria-label="To date"
                />
              </label>
            </>
          ) : null}
          <label className="flex min-w-[12rem] flex-1 flex-col text-[11px] text-ink-muted">
            Search
            <Input
              value={search}
              onChange={(e) => (setSearch(e.target.value), resetPage())}
              placeholder="Memo, reference, JV, invoice, shipment…"
              className="h-9"
              aria-label="Search the ledger"
            />
          </label>
          {types.length > 1 ? (
            <FilterSelect label="Type" value={type} options={types} onChange={(v) => (setType(v), resetPage())} />
          ) : null}
          {currencies.length > 1 ? (
            <FilterSelect label="Currency" value={rowCurrency} options={currencies} onChange={(v) => (setRowCurrency(v), resetPage())} />
          ) : null}
          {shipments.length > 1 ? (
            <FilterSelect label="Shipment" value={shipment} options={shipments} onChange={(v) => (setShipment(v), resetPage())} />
          ) : null}
          {statuses.length > 1 ? (
            <FilterSelect label="Status" value={status} options={statuses} onChange={(v) => (setStatus(v), resetPage())} />
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {toolbar}
            <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Ledger view">
              <button
                type="button"
                aria-pressed={prefs.view === 'table'}
                onClick={() => setPrefs((p) => ({ ...p, view: 'table' }))}
                className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs', prefs.view === 'table' ? 'bg-forest-800 text-white' : 'text-ink-muted')}
                data-testid="ledger-view-table"
              >
                <Rows3 className="size-3.5" /> Table
              </button>
              <button
                type="button"
                aria-pressed={prefs.view === 'compact'}
                onClick={() => setPrefs((p) => ({ ...p, view: 'compact' }))}
                className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs', prefs.view === 'compact' ? 'bg-forest-800 text-white' : 'text-ink-muted')}
                data-testid="ledger-view-compact"
              >
                <LayoutList className="size-3.5" /> Compact
              </button>
            </div>
            <Button size="sm" variant="outline" onClick={() => setCustomizing(true)} data-testid="ledger-customize">
              <SlidersHorizontal /> Customize report
            </Button>
            <PrintButton />
            <ShareTrigger onClick={() => openShare()} />
          </div>
        </div>
        {summary}
        {serverWindow?.trimmed ? (
          <p className="rounded-md border border-gold-300 bg-gold-50 px-3 py-2 text-xs text-ink" data-testid="ledger-window-note">
            Showing the latest {serverWindow.sent.toLocaleString('en-US')} of {serverWindow.total.toLocaleString('en-US')} entries
            {serverWindow.from || serverWindow.to ? ' in these dates' : ''}; the ones before them are carried in the
            &ldquo;Brought forward&rdquo; line. The totals above are for the whole period.
            {dateFilter ? ' Choose a From date to see earlier entries.' : ' Choose earlier dates above to see them.'}
          </p>
        ) : null}
      </div>

      {/* On screen: the table, or one card per row. */}
      <div className="print:hidden">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-ink/70 px-4 py-6 text-center text-sm text-ink-muted">{emptyText}</p>
        ) : prefs.view === 'table' ? (
          <div className="ledger-scroll relative max-h-[75vh] overflow-auto rounded-lg border border-ink/80 bg-surface" data-testid="ledger-scroll">
            <table className="ledger-grid min-w-full text-sm" data-testid="ledger-table">
              <thead>
                <tr>
                  {selecting ? (
                    <th className="ledger-head w-8" data-print="hide">
                      <input
                        type="checkbox"
                        aria-label="Select every row on this page"
                        className="size-4 accent-forest-700"
                        checked={pageRows.length > 0 && pageRows.every((r) => selected.has(r.key))}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const r of pageRows) {
                              if (e.target.checked) next.add(r.key);
                              else next.delete(r.key);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                  ) : null}
                  {columns.map((c) => (
                    <th key={c} className={cn(cellClass(c), 'ledger-head')} data-col={c}>
                      {LEDGER_COLUMN_LABEL[c]}
                    </th>
                  ))}
                  {hasDetails ? <th className="ledger-head w-10" aria-label="Details" /> : null}
                </tr>
              </thead>
              <tbody>
                {figuresRow(broughtForward, { balance: balanceText(firstBalance) }, 'ledger-opening')}
                {pageRows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length + (hasDetails ? 1 : 0) + (selecting ? 1 : 0)} className="py-6 text-center text-ink-muted">
                      No entries match these filters.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((r) => (
                    <React.Fragment key={r.key}>
                      <tr
                        data-testid="ledger-row"
                        className={cn('ledger-row', hasDetails && 'cursor-pointer', open === r.key && 'ledger-row-open')}
                        onClick={hasDetails ? () => setOpen(open === r.key ? null : r.key) : undefined}
                      >
                        {selecting ? (
                          <td className="w-8 text-center" data-print="hide" onClick={(e) => e.stopPropagation()}>
                            <SelectBox checked={selected.has(r.key)} label={`Select ${r.memo || r.reference || r.date}`} onChange={(on) => setSelected((prev) => toggled(prev, r.key, on))} />
                          </td>
                        ) : null}
                        {columns.map((c) => (
                          <td key={c} className={cellClass(c)} data-col={c}>
                            {cell(c, r)}
                          </td>
                        ))}
                        {hasDetails ? (
                          <td className="w-10 text-center">
                            <button
                              type="button"
                              aria-label={open === r.key ? 'Hide details' : 'View details'}
                              aria-expanded={open === r.key}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpen(open === r.key ? null : r.key);
                              }}
                              className="rounded p-1 text-ink-muted hover:bg-forest-50"
                            >
                              {open === r.key ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                      {open === r.key ? (
                        <tr className="ledger-details">
                          <td colSpan={columns.length + 1 + (selecting ? 1 : 0)}>
                            <RowDetails row={r} currency={currency} balance={balanceText(dec(r.balance))} />
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  ))
                )}
              </tbody>
              <tfoot>
                {figuresRow(
                  narrowed ? 'Totals of the rows shown' : serverWindow?.trimmed ? 'Totals for the period' : 'Totals',
                  { debit: formatMoney(totalDebit, currency), credit: formatMoney(totalCredit, currency) },
                  'ledger-totals',
                )}
                {figuresRow('Closing balance', { balance: balanceText(periodClosing) }, 'ledger-closing')}
              </tfoot>
            </table>
          </div>
        ) : (
          <ol className="space-y-2" data-testid="ledger-compact">
            {pageRows.map((r) => (
              <li key={r.key} className="overflow-hidden rounded-lg border border-ink/80 bg-surface text-sm" data-testid="ledger-card">
                <div className="flex items-start justify-between gap-3 border-b border-ink/70 px-3 py-2">
                  {selecting ? (
                    <SelectBox checked={selected.has(r.key)} label={`Select ${r.memo || r.reference || r.date}`} onChange={(on) => setSelected((prev) => toggled(prev, r.key, on))} />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold">{formatDate(new Date(`${r.date}T00:00:00.000Z`))}</span>
                    <span className="line-clamp-2 block text-ink">{r.memo || r.type || '—'}</span>
                  </span>
                  {r.reference ? <span className="shrink-0 text-xs text-ink-muted">{r.reference}</span> : null}
                </div>
                <dl className="grid grid-cols-3 divide-x divide-ink/70 text-xs">
                  {(['debit', 'credit', 'balance'] as const).map((c) => (
                    <div key={c} className="px-3 py-1.5 text-right">
                      <dt className="text-ink-muted">{LEDGER_COLUMN_LABEL[c]}</dt>
                      <dd className="tnum font-medium">{cell(c, r)}</dd>
                    </div>
                  ))}
                </dl>
                {r.details || r.actions || r.facts?.length ? (
                  <details className="border-t border-ink/70 px-3 py-1.5 text-xs">
                    <summary className="cursor-pointer text-forest-800">View details</summary>
                    <RowDetails row={r} currency={currency} balance={balanceText(dec(r.balance))} />
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {shown.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted" data-print="hide" data-testid="ledger-pagination">
            <span>
              Rows {current * prefs.pageSize + 1}–{Math.min(shown.length, (current + 1) * prefs.pageSize)} of {shown.length}
            </span>
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                Per page
                <Select
                  value={String(prefs.pageSize)}
                  onChange={(e) => (setPrefs((p) => ({ ...p, pageSize: Number(e.target.value) as LedgerPrefs['pageSize'] })), resetPage())}
                  className="h-8 w-20"
                  aria-label="Rows per page"
                >
                  {LEDGER_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <Button size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Next
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {/* On paper: every filtered row, in the columns chosen, with its own heading. */}
      <div className="ledger-print hidden print:block" data-testid="ledger-print">
        <div className="mb-2">
          <p className="text-[11pt] font-bold">{companyName}</p>
          <p className="text-[10pt] font-semibold">
            {title} — {subject}
          </p>
          <p className="text-[8.5pt]">
            {period} · {currency}
            {serverWindow?.trimmed ? ` · latest ${serverWindow.sent} of ${serverWindow.total} entries, earlier ones brought forward` : ''}
          </p>
        </div>
        {documentTable}
      </div>

      {selecting ? (
        <div
          className="fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-xl flex-wrap items-center justify-between gap-2 rounded-xl border border-forest-300 bg-surface px-4 py-3 shadow-xl sm:bottom-6"
          data-print="hide"
          data-testid="ledger-selection-bar"
        >
          <span className="text-sm font-medium text-ink">
            {selected.size} row{selected.size === 1 ? '' : 's'} selected
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => (setSelecting(false), setSelected(new Set()))}>
              Cancel
            </Button>
            <Button size="sm" disabled={selected.size === 0} onClick={() => openShare('selected')} data-testid="ledger-share-selected">
              <WhatsAppIcon className="fill-white" /> Share selected
            </Button>
          </span>
        </div>
      ) : null}

      {share ? <ShareDialog key={share.id} open onOpenChange={(o) => !o && setShare(null)} spec={share.spec} /> : null}

      <CustomizeSheet
        open={customizing}
        onOpenChange={setCustomizing}
        report={report}
        available={available}
        prefs={prefs}
        onApply={setPrefs}
      />
    </section>
  );
}

function toggled(prev: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(prev);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function SelectBox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-4 shrink-0 accent-forest-700"
      data-testid="ledger-select-row"
    />
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col text-[11px] text-ink-muted">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-40" aria-label={`Filter by ${label.toLowerCase()}`}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </label>
  );
}

function RowDetails({ row, currency, balance }: { row: LedgerReportRow; currency: string; balance: string }) {
  const facts: Array<[string, React.ReactNode]> = [
    ['Memo', [row.memo, row.memoNote].filter(Boolean).join(' — ') || '—'],
    ['Reference', row.reference ?? '—'],
    ['JV No.', row.jv ?? '—'],
    ['Type', row.type ?? '—'],
    ['Debit', dec(row.debit).isZero() ? '—' : formatMoney(dec(row.debit), currency)],
    ['Credit', dec(row.credit).isZero() ? '—' : formatMoney(dec(row.credit), currency)],
    ['Balance after', balance],
  ];
  if (row.shipment) {
    facts.push([
      'Shipment',
      row.shipment.href ? (
        <Link key="s" href={row.shipment.href} className="text-forest-800 hover:text-gold-700">
          {row.shipment.label}
        </Link>
      ) : (
        row.shipment.label
      ),
    ]);
  }
  if (row.invoices?.length) facts.push(['Invoice', row.invoices.map((i) => i.label).join(', ')]);
  if (row.party) facts.push(['Party', row.party]);
  if (row.status) facts.push(['Status', row.status]);
  if (row.createdBy) facts.push(['Created by', row.createdBy]);
  for (const fact of row.facts ?? []) facts.push([fact.label, fact.value]);
  return (
    <div className="space-y-3 px-1 py-2 text-xs" data-testid="ledger-row-details">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-ink-muted">{label}</dt>
            <dd className="font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {row.details}
      {row.actions ? <div className="flex flex-wrap gap-2">{row.actions}</div> : null}
    </div>
  );
}

/** Choose and order the columns, then save them for this person and this ledger. */
function CustomizeSheet({
  open,
  onOpenChange,
  report,
  available,
  prefs,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: LedgerReportKey;
  available: LedgerColumnKey[];
  prefs: LedgerPrefs;
  onApply: (prefs: LedgerPrefs) => void;
}) {
  const [draft, setDraft] = React.useState<LedgerColumnKey[]>(prefs.columns);
  const [saving, startSaving] = React.useTransition();
  const [lastOpen, setLastOpen] = React.useState(open);
  // Each time the panel opens it starts from what is on screen.
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setDraft(prefs.columns);
  }

  const offered = [...new Set<LedgerColumnKey>([...CORE_LEDGER_COLUMNS, ...available])];
  const hidden = offered.filter((c) => !draft.includes(c));
  const move = (index: number, by: number) =>
    setDraft((cols) => {
      const next = [...cols];
      const [col] = next.splice(index, 1);
      next.splice(index + by, 0, col);
      return next;
    });

  const persist = (next: LedgerPrefs | null) =>
    startSaving(async () => {
      const result = await saveLedgerPrefsAction(report, next);
      if (result.ok) {
        const applied = next ? { ...next, saved: true } : { ...normaliseLedgerPrefs(DEFAULT_LEDGER_PREFS, available), saved: false };
        onApply(applied);
        setDraft(applied.columns);
        toast.success(next ? 'Layout saved for this ledger.' : 'Back to the default layout.');
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Customize report" description="Choose the columns and their order. Saved for you, for this ledger; printing follows it.">
      <div className="space-y-4" data-testid="ledger-customize-panel">
        <ol className="space-y-1">
          {draft.map((c, index) => (
            <li key={c} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm" data-testid="ledger-column-option">
              <input
                type="checkbox"
                checked
                disabled={CORE_LEDGER_COLUMNS.includes(c)}
                onChange={() => setDraft((cols) => cols.filter((x) => x !== c))}
                aria-label={LEDGER_COLUMN_LABEL[c]}
                className="size-4 accent-forest-700"
              />
              <span className="flex-1">
                {LEDGER_COLUMN_LABEL[c]}
                {CORE_LEDGER_COLUMNS.includes(c) ? <span className="ml-2 text-[11px] text-ink-subtle">always shown</span> : null}
              </span>
              <button type="button" aria-label={`Move ${LEDGER_COLUMN_LABEL[c]} up`} disabled={index === 0} onClick={() => move(index, -1)} className="rounded p-1 text-ink-muted hover:bg-surface-sunken disabled:opacity-30">
                <ArrowUp className="size-3.5" />
              </button>
              <button type="button" aria-label={`Move ${LEDGER_COLUMN_LABEL[c]} down`} disabled={index === draft.length - 1} onClick={() => move(index, 1)} className="rounded p-1 text-ink-muted hover:bg-surface-sunken disabled:opacity-30">
                <ArrowDown className="size-3.5" />
              </button>
            </li>
          ))}
        </ol>
        {hidden.length ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-muted">More columns</p>
            {hidden.map((c) => (
              <label key={c} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-surface-sunken">
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => setDraft((cols) => [...cols, c])}
                  aria-label={LEDGER_COLUMN_LABEL[c]}
                  className="size-4 accent-forest-700"
                />
                {LEDGER_COLUMN_LABEL[c]}
              </label>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-3">
          <Button variant="outline" onClick={() => persist(null)} loading={saving} data-testid="ledger-customize-reset">
            <RotateCcw /> Reset to default
          </Button>
          <Button onClick={() => persist({ ...prefs, columns: draft })} loading={saving} data-testid="ledger-customize-save">
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
