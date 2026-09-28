import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';
import { ledgerCurrencyTabs, type LedgerResult } from '@/lib/services/ledger';
import { getLedgerPrefs } from '@/lib/services/ledger-prefs';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';
import { LedgerReport, type LedgerReportRow } from '@/components/ledger/ledger-report';
import { businessNumber, shortDocumentNumber } from '@/lib/short-number';
import type { LedgerColumnKey } from '@/lib/ledger-columns';
import type { LedgerDocument } from '@/lib/services/ledger-sql';

function documentHref(doc: LedgerDocument): string {
  if (doc.kind === 'ORDER') return `/purchases/${doc.id}`;
  if (doc.kind === 'EXPENSE') return `/finance/expenses/${doc.id}`;
  return `/sales/${doc.id}`;
}

function documentName(doc: LedgerDocument): string {
  if (doc.kind === 'ORDER') return doc.number;
  if (doc.kind === 'EXPENSE') return businessNumber(doc.number);
  return shortDocumentNumber(doc.number);
}

const AVAILABLE: LedgerColumnKey[] = ['reference', 'jv', 'type', 'invoice', 'shipment', 'currency', 'status'];

/**
 * A customer's or supplier's ledger, in the one ledger layout the whole
 * application uses (see LedgerReport), filtered by the currency the vouchers
 * were raised in: USD shows USD transactions and balance, MAD shows MAD, and
 * the two are never added into one total.
 */
export async function LedgerView({
  ledger,
  basePath,
  extraQuery,
  partyCurrency,
  localCurrency,
  emptyDescription,
  canDelete = false,
  report,
  subject,
  userId,
  companyName,
  mode,
}: {
  ledger: LedgerResult;
  basePath: string;
  extraQuery?: Record<string, string | undefined>;
  partyCurrency: string;
  localCurrency: string;
  emptyDescription: string;
  /** Whether a posting on this ledger can be taken back out of the books here. */
  canDelete?: boolean;
  report: 'customer' | 'supplier';
  subject: string;
  userId: string;
  companyName: string;
  /** 'document' for a printed statement: the table only. */
  mode?: 'interactive' | 'document';
}) {
  const currencies = ledgerCurrencyTabs(localCurrency, partyCurrency);
  const selected = ledger.currencyFilter ?? ledger.viewCurrency;
  const currency = ledger.viewCurrency;
  const prefs = await getLedgerPrefs(userId, report, AVAILABLE);

  const hrefFor = (code: string) => {
    const params = new URLSearchParams();
    params.set('currency', code);
    if (extraQuery) {
      for (const [key, value] of Object.entries(extraQuery)) {
        if (value && key !== 'view' && key !== 'currency') params.set(key, value);
      }
    }
    return `${basePath}?${params.toString()}`;
  };

  // Amounts in the currency being viewed: the voucher's own when it is that
  // currency, otherwise its equivalent at the voucher's own rate.
  const inView = (own: LedgerResult['rows'][number]['debit'], rowCurrency: string, usd: typeof own, local: typeof own) =>
    rowCurrency === currency ? own : currency === 'USD' ? usd : currency === localCurrency ? local : own;

  const rows: LedgerReportRow[] = ledger.rows.map((row, index) => ({
    key: `${row.journalEntryId}-${index}`,
    date: row.entryDate.toISOString().slice(0, 10),
    reference: businessNumber(row.reference ?? row.entryNumber),
    jv: businessNumber(row.entryNumber),
    type: row.typeLabel,
    memo: row.memo ?? row.description,
    memoNote: row.collectedBy ? `Collected by ${row.collectedBy}` : null,
    invoices: row.documents.map((doc) => ({ label: documentName(doc), href: documentHref(doc) })),
    shipment: row.shipmentNumber ? { label: row.shipmentNumber } : null,
    currency: row.currency,
    debit: inView(row.debit, row.currency, row.debitUsd, row.debitLocal).toString(),
    credit: inView(row.credit, row.currency, row.creditUsd, row.creditLocal).toString(),
    balance: row.balance.toString(),
    // The voucher's own amount, and its equivalent at the voucher's own rate.
    facts: [
      {
        label: 'Amount',
        value: formatMoney(row.debit.greaterThan(0) ? row.debit : row.credit, row.currency),
      },
      {
        label: row.currency === 'USD' ? `Equivalent (${localCurrency})` : 'Equivalent (USD)',
        value:
          row.currency === 'USD'
            ? formatMoney(row.debitLocal.greaterThan(0) ? row.debitLocal : row.creditLocal, localCurrency)
            : formatMoney(row.debitUsd.greaterThan(0) ? row.debitUsd : row.creditUsd, 'USD'),
      },
    ],
    actions: (
      <JournalSourceActions
        sourceType={row.sourceType}
        sourceId={row.sourceId}
        entryNumber={row.entryNumber}
        journalEntryId={row.journalEntryId}
        canDelete={canDelete}
      />
    ),
  }));

  return (
    <LedgerReport
      report={report}
      title={report === 'customer' ? 'Customer ledger' : 'Supplier ledger'}
      subject={subject}
      currency={currency}
      // A customer's running balance counts what they owe (Dr); a supplier's
      // counts what is owed to them (Cr).
      balanceSide={report === 'customer' ? 'debit' : 'credit'}
      opening={ledger.openingBalance.toString()}
      rows={rows}
      available={AVAILABLE}
      initialPrefs={prefs}
      companyName={companyName}
      periodLabel={extraQuery?.from || extraQuery?.to ? `${extraQuery?.from ?? 'the start'} – ${extraQuery?.to ?? 'today'}` : undefined}
      dateFilter={false}
      mode={mode}
      emptyText={emptyDescription}
      toolbar={
        currencies.length > 1 ? (
          <span className="inline-flex shrink-0 rounded-lg border border-line-strong p-0.5">
            {currencies.map((code) => (
              <Link
                key={code}
                href={hrefFor(code)}
                title={`Show ${code} transactions only`}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  selected === code ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
                )}
              >
                {code}
              </Link>
            ))}
          </span>
        ) : null
      }
    />
  );
}
