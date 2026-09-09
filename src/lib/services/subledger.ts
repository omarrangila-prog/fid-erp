import { Decimal, dec, convertFromUsd } from '@/lib/money';
import { BusinessRuleError } from '@/lib/errors';

/**
 * Works out how to express a cash voucher on the customer/vendor side of the
 * journal entry.
 *
 * A party's ledger is kept in that party's own currency — Dubai customers are
 * carried in USD, Morocco customers in MAD — while the cash leg is in whatever
 * currency actually moved. This resolves the receivable/payable leg so that the
 * entry still balances exactly in USD.
 *
 * Three cases are supported, and anything else is rejected loudly rather than
 * posted with an approximated rate:
 *
 *   1. party currency == voucher currency  → post at the voucher's own rate
 *   2. party currency == USD               → post the USD equivalent at rate 1
 *   3. party currency == company local     → post at the voucher's local rate
 */
export function resolveSubledgerLeg(params: {
  partyCurrency: string;
  voucherCurrency: string;
  voucherAmount: Decimal | string | number;
  voucherRateToUsd: Decimal | string | number;
  voucherAmountUsd: Decimal | string | number;
  localCurrency: string;
  rateLocalPerUsd: Decimal | string | number;
  partyLabel: string;
}): { currency: string; amount: Decimal; rateToUsd: Decimal } {
  const partyCurrency = params.partyCurrency.toUpperCase();
  const voucherCurrency = params.voucherCurrency.toUpperCase();
  const localCurrency = params.localCurrency.toUpperCase();

  if (partyCurrency === voucherCurrency) {
    return {
      currency: partyCurrency,
      amount: dec(params.voucherAmount),
      rateToUsd: dec(params.voucherRateToUsd),
    };
  }

  if (partyCurrency === 'USD') {
    return { currency: 'USD', amount: dec(params.voucherAmountUsd), rateToUsd: new Decimal(1) };
  }

  if (partyCurrency === localCurrency) {
    const rateLocalPerUsd = dec(params.rateLocalPerUsd);
    return {
      currency: partyCurrency,
      amount: convertFromUsd(params.voucherAmountUsd, rateLocalPerUsd, partyCurrency),
      rateToUsd: rateLocalPerUsd,
    };
  }

  throw new BusinessRuleError(
    `${params.partyLabel} is carried in ${partyCurrency}, which cannot be settled from a ${voucherCurrency} voucher in a ${localCurrency} company. Use a ${partyCurrency}, USD or ${localCurrency} account.`,
  );
}
