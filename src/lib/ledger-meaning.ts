import type { AccountType } from '@prisma/client';
import { dec, type Decimal } from '@/lib/money';

/**
 * What a ledger balance actually means, in words.
 *
 * A ledger shows debits minus credits, so a liability the company owes reads
 * as a negative number. That is correct and it is also unreadable: the client
 * opened "F I D TRADING LLC DUBAI", saw −50,000, and could not tell whether
 * that meant they owed Dubai or Dubai owed them.
 *
 * So the sign is turned back into a sentence. The figure is shown as a
 * positive amount with a label that says which way round it is, and the raw
 * signed balance stays on the row where an accountant expects it.
 */

export type LedgerMeaning = {
  /** "Payable to Ahmed", "Receivable from Ahmed", "Cash in hand"… */
  label: string;
  /** The amount to show, always positive. */
  amount: Decimal;
  /** True when the balance is on the side the account normally sits. */
  normal: boolean;
  /** Nothing owed either way. */
  settled: boolean;
  /** A sentence a person can read without knowing double entry. */
  sentence: string;
};

/**
 * @param balance debits minus credits, as the ledger reports it
 * @param type    the account's statutory type
 * @param name    what to call the other side — usually the account name
 */
export function describeLedgerBalance(
  balance: Decimal | string | number,
  type: AccountType,
  name: string,
): LedgerMeaning {
  const value = dec(balance);
  const amount = value.abs();
  const settled = amount.isZero();
  const debitSide = value.greaterThan(0);

  if (settled) {
    return {
      label: 'Settled',
      amount,
      normal: true,
      settled: true,
      sentence: `Nothing is owed either way on ${name}.`,
    };
  }

  switch (type) {
    case 'LIABILITY':
      return debitSide
        ? {
            label: `Overpaid — ${name} owes us`,
            amount,
            normal: false,
            settled: false,
            sentence: `More has been paid than was owed, so ${name} is holding our money.`,
          }
        : {
            label: `Payable to ${name}`,
            amount,
            normal: true,
            settled: false,
            sentence: `The company owes ${name} this much.`,
          };

    case 'ASSET':
      return debitSide
        ? {
            label: `Receivable from ${name}`,
            amount,
            normal: true,
            settled: false,
            sentence: `${name} owes the company this much.`,
          }
        : {
            label: `Payable to ${name}`,
            amount,
            normal: false,
            settled: false,
            sentence: `This account has gone the other way: the company owes ${name} this much.`,
          };

    case 'INCOME':
      return debitSide
        ? {
            label: 'Reduction in income',
            amount,
            normal: false,
            settled: false,
            sentence: `${name} has been reduced by this much — credit notes or a correction.`,
          }
        : {
            label: 'Income earned',
            amount,
            normal: true,
            settled: false,
            sentence: `The business earned this much through ${name}.`,
          };

    case 'EXPENSE':
      return debitSide
        ? {
            label: 'Spent',
            amount,
            normal: true,
            settled: false,
            sentence: `The business spent this much on ${name}.`,
          }
        : {
            label: 'Refunded',
            amount,
            normal: false,
            settled: false,
            sentence: `More has come back than went out on ${name}.`,
          };

    case 'EQUITY':
    default:
      return debitSide
        ? {
            label: 'Drawn out',
            amount,
            normal: false,
            settled: false,
            sentence: `This much has been taken out of ${name}.`,
          }
        : {
            label: 'Held in the business',
            amount,
            normal: true,
            settled: false,
            sentence: `This much stands to ${name}.`,
          };
  }
}
