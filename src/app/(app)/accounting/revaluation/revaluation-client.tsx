'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { postRevaluationAction } from '@/server/actions/finance-actions';

export type PreviewLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  currency: string;
  balanceUsd: string;
  carriedLocal: string;
  revaluedLocal: string;
  differenceLocal: string;
  differenceValue: number;
};

/**
 * Foreign-currency revaluation.
 *
 * Balances held in a currency other than the books' own drift as the rate
 * moves. This restates them at a chosen closing rate and books the difference
 * to exchange gain or loss — without touching any historical voucher, which
 * keeps its original rate for good.
 */
export function RevaluationClient({
  asOf,
  rates,
  preview,
  netDifference,
  localCurrency,
  canPost,
}: {
  asOf: string;
  rates: Array<{ currency: string; rate: string }>;
  preview: PreviewLine[];
  netDifference: string;
  localCurrency: string;
  canPost: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [date, setDate] = React.useState(asOf);
  const [values, setValues] = React.useState<Record<string, string>>(
    () => Object.fromEntries(rates.map((r) => [r.currency, r.rate])),
  );
  const [error, setError] = React.useState<string | null>(null);

  function recalculate() {
    const params = new URLSearchParams({ asOf: date });
    for (const [currency, rate] of Object.entries(values)) params.set(`rate_${currency}`, rate);
    router.push(`/accounting/revaluation?${params.toString()}`);
  }

  function post() {
    setError(null);
    startTransition(async () => {
      const result = await postRevaluationAction(JSON.stringify({ asOf: date, rates: values }));
      if (result?.ok) {
        toast.success('Revaluation posted.');
        router.refresh();
      } else {
        setError(result?.error || 'The revaluation could not be posted.');
      }
    });
  }

  return (
    <div className="space-y-4">
      <Callout tone="info" title="Historical vouchers are never restated">
        This posts one entry, dated as at the date below, that brings foreign-currency balances onto the closing
        rate. Every earlier receipt and payment keeps the rate it was entered at.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Closing rates</CardTitle>
          <CardDescription>Units of each currency per 1 USD, as at the revaluation date.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="As at" htmlFor="rev-date" required>
            <Input id="rev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {rates.map((rate) => (
            <Field key={rate.currency} label={`${rate.currency} per USD`} htmlFor={`rev-${rate.currency}`}>
              <Input
                id={`rev-${rate.currency}`}
                className="tnum"
                value={values[rate.currency] ?? ''}
                onChange={(e) => setValues((current) => ({ ...current, [rate.currency]: e.target.value }))}
              />
            </Field>
          ))}
          <div className="flex items-end">
            <Button variant="outline" onClick={recalculate} type="button" className="w-full sm:w-auto">
              <RefreshCcw />
              Recalculate
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What would be posted</CardTitle>
          <CardDescription>
            Nothing is written until you post. Amounts are in {localCurrency}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview.length === 0 ? (
            <EmptyState
              title="Nothing needs revaluing"
              description="No account carries a foreign-currency balance that differs at these rates."
            />
          ) : (
            <TableWrap>
              <Table>
                <THead className="sticky-head">
                  <TR className="hover:bg-transparent">
                    <TH className="pin-left">Account</TH>
                    <TH>Currency</TH>
                    <TH numeric>Balance USD</TH>
                    <TH numeric>Carried {localCurrency}</TH>
                    <TH numeric>Revalued {localCurrency}</TH>
                    <TH numeric>Difference</TH>
                  </TR>
                </THead>
                <TBody>
                  {preview.map((line) => (
                    <TR key={`${line.accountId}-${line.currency}`}>
                      <TD className="pin-left">
                        <span className="block font-medium text-forest-800">{line.accountName}</span>
                        <span className="block text-xs text-ink-subtle">{line.accountCode}</span>
                      </TD>
                      <TD>{line.currency}</TD>
                      <TD numeric>{line.balanceUsd}</TD>
                      <TD numeric>{line.carriedLocal}</TD>
                      <TD numeric>{line.revaluedLocal}</TD>
                      <TD numeric className={line.differenceValue < 0 ? 'text-red-600' : 'text-emerald-700'}>
                        {line.differenceLocal}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD className="pin-left font-semibold">Net difference</TD>
                    <TD colSpan={4} />
                    <TD numeric className="font-semibold">{netDifference}</TD>
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>

      {error ? (
        <Callout tone="danger" title="The revaluation was not posted">
          {error}
        </Callout>
      ) : null}

      {canPost && preview.length > 0 ? (
        <div className="flex justify-end">
          <Button onClick={post} loading={pending}>
            Post revaluation
          </Button>
        </div>
      ) : null}
    </div>
  );
}
