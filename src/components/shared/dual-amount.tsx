import type { DecimalInput } from '@/lib/money';
import { equivalentOf, rateLabel } from '@/lib/dual-currency';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * An amount in the currency it happened in, with its equivalent underneath.
 *
 *   MAD 46,000.00        the transaction's own currency: primary
 *   ≈ USD 4,791.67       the equivalent at its own rate: secondary
 *
 * Hover the equivalent for the rate it used. When a transaction has no rate,
 * the equivalent says it is not available rather than inventing one. The
 * books are never touched: this is display only.
 */
export function DualAmount({
  amount,
  currency,
  localCurrency,
  rateLocalPerUsd,
  amountUsd,
  amountLocal,
  rateSource = 'Historical transaction rate',
  className,
  primaryClassName,
  hideMissing = false,
}: {
  amount: DecimalInput;
  currency: string;
  localCurrency: string;
  rateLocalPerUsd?: DecimalInput | null;
  amountUsd?: DecimalInput | null;
  amountLocal?: DecimalInput | null;
  /** What the rate is, for the tooltip — a transaction's own, or a weighted average. */
  rateSource?: string;
  className?: string;
  primaryClassName?: string;
  /** For a figure where a missing equivalent is not worth a line. */
  hideMissing?: boolean;
}) {
  const equivalent = equivalentOf({ amount, currency, localCurrency, rateLocalPerUsd, amountUsd, amountLocal });
  const rate = rateLabel(equivalent?.rate, localCurrency);
  const needsOne = currency.toUpperCase() !== 'USD' || localCurrency.toUpperCase() !== 'USD';
  return (
    <span className={cn('inline-block', className)} data-dual-amount>
      <span className={cn('tnum block font-semibold', primaryClassName)}>{formatMoney(amount, currency)}</span>
      {equivalent ? (
        <span className="tnum block text-[11px] font-normal text-ink-subtle" title={rate ? `${rate} · ${rateSource}` : rateSource}>
          ≈ {formatMoney(equivalent.amount, equivalent.currency)}
        </span>
      ) : needsOne && !hideMissing ? (
        <span className="block text-[11px] font-normal text-ink-subtle">
          {currency.toUpperCase() === 'USD' ? localCurrency : 'USD'} equivalent not available
        </span>
      ) : null}
    </span>
  );
}
