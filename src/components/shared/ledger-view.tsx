import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatMoney, formatDate, formatRate, titleCase } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import type { LedgerResult, LedgerView as LedgerViewMode } from '@/lib/services/ledger';

/**
 * The dual-view party ledger.
 *
 * Switching the view reads a different stored column — the USD equivalent, the
 * local equivalent, or the original transaction amount — all of which were
 * frozen when each voucher was posted. Nothing is re-converted at read time, so
 * changing today's rate cannot restate last month's ledger.
 */
export function LedgerView({
  ledger,
  basePath,
  partyCurrency,
  localCurrency,
  emptyDescription,
}: {
  ledger: LedgerResult;
  basePath: string;
  partyCurrency: string;
  localCurrency: string;
  emptyDescription: string;
}) {
  const modes: Array<{ mode: LedgerViewMode; label: string; hint: string }> = [
    { mode: 'TRANSACTION', label: partyCurrency, hint: 'As each voucher was raised' },
    { mode: 'USD', label: 'USD', hint: 'Group reporting' },
    { mode: 'LOCAL', label: localCurrency, hint: 'Local books' },
  ];

  const currency = ledger.viewCurrency;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>
            Every row keeps the exchange rate it was posted at. Switching the view does not re-convert anything.
          </CardDescription>
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-line-strong p-0.5">
          {modes.map((option) => (
            <Link
              key={option.mode}
              href={`${basePath}?view=${option.mode}`}
              title={option.hint}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                ledger.view === option.mode ? 'bg-navy-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {option.label}
            </Link>
          ))}
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        {ledger.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No ledger entries" description={emptyDescription} />
          </div>
        ) : (
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Date</TH>
                  <TH>Reference</TH>
                  <TH>Description</TH>
                  <TH>Shipment</TH>
                  {ledger.view !== 'TRANSACTION' ? <TH numeric>Rate</TH> : null}
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                  <TH numeric>Balance</TH>
                </TR>
              </THead>
              <TBody>
                <TR className="bg-navy-50/40 hover:bg-navy-50/40">
                  <TD colSpan={ledger.view !== 'TRANSACTION' ? 7 : 6} className="text-xs font-medium text-ink-muted">
                    Opening balance
                  </TD>
                  <TD numeric className="font-semibold">
                    {formatMoney(ledger.openingBalance, currency)}
                  </TD>
                </TR>

                {ledger.rows.map((row, index) => {
                  const debit =
                    ledger.view === 'USD' ? row.debitUsd : ledger.view === 'LOCAL' ? row.debitLocal : row.debit;
                  const credit =
                    ledger.view === 'USD' ? row.creditUsd : ledger.view === 'LOCAL' ? row.creditLocal : row.credit;

                  return (
                    <TR key={`${row.journalEntryId}-${index}`}>
                      <TD>{formatDate(row.entryDate)}</TD>
                      <TD className="font-medium">{row.reference ?? row.entryNumber}</TD>
                      <TD>
                        <span className="block">{row.description}</span>
                        <span className="block text-xs text-ink-subtle">{titleCase(row.sourceType)}</span>
                      </TD>
                      <TD className="text-xs">{row.shipmentNumber ?? '—'}</TD>
                      {ledger.view !== 'TRANSACTION' ? (
                        <TD numeric className="text-xs text-ink-muted">
                          {row.currency === currency ? '—' : formatRate(row.rateToUsd)}
                        </TD>
                      ) : null}
                      <TD numeric>{debit.greaterThan(0) ? formatMoney(debit, currency) : '—'}</TD>
                      <TD numeric>{credit.greaterThan(0) ? formatMoney(credit, currency) : '—'}</TD>
                      <TD numeric className="font-medium">
                        {formatMoney(row.balance, currency)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={ledger.view !== 'TRANSACTION' ? 5 : 4}>Closing balance</TD>
                  <TD numeric>{formatMoney(ledger.totalDebit, currency)}</TD>
                  <TD numeric>{formatMoney(ledger.totalCredit, currency)}</TD>
                  <TD numeric>{formatMoney(ledger.closingBalance, currency)}</TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        )}
      </CardContent>
    </Card>
  );
}
