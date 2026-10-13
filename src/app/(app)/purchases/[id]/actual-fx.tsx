'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormError } from '@/components/shared/form-error';
import { dec, tryDec } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { setPurchaseActualFxAction } from '@/server/actions/trading-actions';
import { PURCHASE_FX_LABELS } from '@/lib/purchase-fx';

/**
 * The rate actually paid for the dollars that settle this order.
 *
 * The order was placed at the best rate available that day. The real one is
 * only known when the dollars are bought, and until then every local figure
 * derived from this order is stated at a rate nobody paid. Entering it here
 * moves the costing everywhere at once: there is no second screen to correct,
 * because every page reads this rate rather than keeping a copy.
 *
 * What it never changes is the dollars. The supplier is owed the same amount
 * whatever the dirhams cost, and the figure is shown so that is plain.
 */
export function ActualFxCard({
  contractId,
  localCurrency,
  purchaseUsd,
  estimatedRate,
  actualRate,
  note,
  setAt,
  setBy,
  canEdit,
}: {
  contractId: string;
  localCurrency: string;
  /** The order's value in dollars — what the supplier is owed. */
  purchaseUsd: string;
  estimatedRate: string;
  actualRate: string | null;
  note: string | null;
  setAt: string | null;
  setBy: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [rate, setRate] = React.useState(actualRate ?? '');
  const [reason, setReason] = React.useState(note ?? '');
  const [error, setError] = React.useState<string | null>(null);

  const usd = tryDec(purchaseUsd);
  const estimate = tryDec(estimatedRate);
  const typed = tryDec(rate);
  const confirmed = actualRate !== null;

  // What the rate being typed does to the local cost, before it is saved.
  const estimatedLocal = usd.times(estimate);
  const preview = typed.greaterThan(0) ? usd.times(typed) : null;
  const difference = preview ? preview.minus(estimatedLocal) : null;

  function save(next: string | null) {
    setError(null);
    if (next !== null && !tryDec(next).greaterThan(0)) {
      setError(`Enter how many ${localCurrency} one dollar actually cost.`);
      return;
    }
    start(async () => {
      const result = await setPurchaseActualFxAction(
        JSON.stringify({ contractId, actualRateLocalPerUsd: next, note: next === null ? '' : reason }),
      );
      if (result?.ok) {
        toast.success(result.message ?? 'Saved.');
        router.refresh();
      } else {
        setError(result?.error ?? 'The rate could not be saved.');
      }
    });
  }

  return (
    <Card data-testid="actual-fx">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Purchase exchange rate</CardTitle>
            <CardDescription>
              What a dollar cost. The supplier is owed {formatMoney(usd, 'USD')} whatever the rate — only the{' '}
              {localCurrency} cost of those dollars changes, and with it the costing of everything on this order.
            </CardDescription>
          </div>
          <Badge tone={confirmed ? 'success' : 'neutral'}>
            {confirmed ? PURCHASE_FX_LABELS.ACTUAL : PURCHASE_FX_LABELS.ESTIMATED}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto]">
          <dt className="text-ink-muted">Estimated when ordered</dt>
          <dd className="text-ink-subtle">1 USD = {estimate.toString()} {localCurrency}</dd>
          <dd className="tnum text-right">{formatMoney(estimatedLocal, localCurrency)}</dd>
          {confirmed ? (
            <>
              <dt className="font-medium text-ink">Actually paid</dt>
              <dd className="text-ink-subtle">
                1 USD = {dec(actualRate).toString()} {localCurrency}
                {note ? ` · ${note}` : ''}
              </dd>
              <dd className="tnum text-right font-semibold">
                {formatMoney(usd.times(dec(actualRate)), localCurrency)}
              </dd>
            </>
          ) : null}
        </dl>

        {setAt && confirmed ? (
          <p className="text-xs text-ink-subtle">
            Confirmed {setAt}
            {setBy ? ` by ${setBy}` : ''}. Costing uses this rate.
          </p>
        ) : null}

        {canEdit ? (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={`Rate actually paid (${localCurrency} per 1 USD)`}
                htmlFor="actual-fx-rate"
                hint="When the dollars were bought to pay the supplier."
              >
                <Input
                  id="actual-fx-rate"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder={estimate.toString()}
                  className="tnum text-right"
                />
              </Field>
              <Field label="Reference" htmlFor="actual-fx-note" hint="A bank advice or transfer reference.">
                <Input
                  id="actual-fx-note"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Optional"
                />
              </Field>
            </div>

            {/* The size of the change, before it is made. */}
            {difference && !difference.isZero() ? (
              <p className="text-sm text-amber-900" data-testid="actual-fx-preview">
                At {typed.toString()} the coffee costs {formatMoney(preview!, localCurrency)} —{' '}
                <strong>
                  {difference.greaterThan(0) ? 'more' : 'less'} by {formatMoney(difference.abs(), localCurrency)}
                </strong>{' '}
                than the estimate. The {formatMoney(usd, 'USD')} owed to the supplier does not change.
              </p>
            ) : null}

            <FormError message={error} />

            <div className="flex flex-wrap justify-end gap-2">
              {confirmed ? (
                <Button variant="ghost" onClick={() => save(null)} loading={pending}>
                  Back to the estimate
                </Button>
              ) : null}
              <Button onClick={() => save(rate)} loading={pending} data-testid="save-actual-fx">
                {confirmed ? 'Update the rate' : 'Confirm the rate paid'}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
