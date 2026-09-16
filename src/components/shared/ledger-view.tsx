import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { ledgerCurrencyTabs, type LedgerResult } from '@/lib/services/ledger';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';

/**
 * Party ledger filtered by the currency the voucher was actually raised in.
 *
 * USD shows USD transactions and the USD balance. MAD shows MAD transactions
 * and the MAD balance. The two are never added into one total.
 */
export function LedgerView({
  ledger,
  basePath,
  extraQuery,
  partyCurrency,
  localCurrency,
  emptyDescription,
}: {
  ledger: LedgerResult;
  basePath: string;
  extraQuery?: Record<string, string | undefined>;
  partyCurrency: string;
  localCurrency: string;
  emptyDescription: string;
}) {
  const currencies = ledgerCurrencyTabs(localCurrency, partyCurrency);
  const selected = ledger.currencyFilter ?? ledger.viewCurrency;
  const currency = ledger.viewCurrency;

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

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>
            Choose a currency to see only that currency’s transactions and balance. USD and MAD are never mixed into
            one total.
          </CardDescription>
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-line-strong p-0.5">
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
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        {ledger.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title={`No ${currency} ledger entries`} description={emptyDescription} />
          </div>
        ) : (
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Date</TH>
                  <TH>Voucher</TH>
                  <TH>Reference</TH>
                  <TH>Type</TH>
                  <TH>Description</TH>
                  <TH>Shipment</TH>
                  <TH>Currency</TH>
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                  <TH numeric>Balance</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                <TR className="bg-forest-50/40 hover:bg-forest-50/40">
                  <TD colSpan={9} className="text-xs font-medium text-ink-muted">
                    Opening balance ({currency})
                  </TD>
                  <TD numeric className="font-semibold">
                    {formatMoney(ledger.openingBalance, currency)}
                  </TD>
                  <TD />
                </TR>

                {ledger.rows.map((row, index) => (
                  <TR key={`${row.journalEntryId}-${index}`}>
                    <TD className="whitespace-nowrap">{formatDate(row.entryDate)}</TD>
                    <TD className="font-medium whitespace-nowrap">{row.entryNumber}</TD>
                    <TD className="text-xs">{row.reference ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-xs">{titleCase(row.sourceType)}</TD>
                    <TD>{row.description}</TD>
                    <TD className="text-xs">{row.shipmentNumber ?? '—'}</TD>
                    <TD className="text-xs">{row.currency}</TD>
                    <TD numeric>{row.debit.greaterThan(0) ? formatMoney(row.debit, row.currency) : '—'}</TD>
                    <TD numeric>{row.credit.greaterThan(0) ? formatMoney(row.credit, row.currency) : '—'}</TD>
                    <TD numeric className="font-medium">
                      {formatMoney(row.balance, currency)}
                    </TD>
                    <TD>
                      <JournalSourceActions
                        sourceType={row.sourceType}
                        sourceId={row.sourceId}
                        entryNumber={row.entryNumber}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={7}>Closing balance ({currency})</TD>
                  <TD numeric>{formatMoney(ledger.totalDebit, currency)}</TD>
                  <TD numeric>{formatMoney(ledger.totalCredit, currency)}</TD>
                  <TD numeric>{formatMoney(ledger.closingBalance, currency)}</TD>
                  <TD />
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        )}
      </CardContent>
    </Card>
  );
}
