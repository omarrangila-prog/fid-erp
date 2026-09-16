import { describe, expect, it } from 'vitest';
import {
  ledgerHref,
  ledgerCurrencyLabel,
  pickCashBankCurrency,
  resolveLedgerViewCurrency,
} from '@/lib/ledger-currency';

describe('resolveLedgerViewCurrency', () => {
  it('opens Cash in Hand MAD as MAD, not USD only', () => {
    expect(
      resolveLedgerViewCurrency({
        accountCurrency: 'MAD',
        cashBankCurrency: 'MAD',
      }),
    ).toBe('MAD');
  });

  it('lets an explicit USD request still filter to USD', () => {
    expect(
      resolveLedgerViewCurrency({
        requested: 'USD',
        accountCurrency: 'MAD',
        cashBankCurrency: 'MAD',
      }),
    ).toBe('USD');
  });

  it('prefers the cash-bank currency when the GL head currency is missing', () => {
    expect(
      resolveLedgerViewCurrency({
        accountCurrency: null,
        cashBankCurrency: 'MAD',
      }),
    ).toBe('MAD');
  });

  it('falls back to USD for heads with no native currency', () => {
    expect(resolveLedgerViewCurrency({})).toBe('USD');
  });
});

describe('pickCashBankCurrency', () => {
  it('prefers MAD when both MAD and USD drawers exist on one head', () => {
    expect(pickCashBankCurrency([{ currency: 'USD' }, { currency: 'MAD' }])).toBe('MAD');
  });

  it('honours an explicit prefer currency', () => {
    expect(pickCashBankCurrency([{ currency: 'USD' }, { currency: 'MAD' }], 'USD')).toBe('USD');
  });
});

describe('ledgerHref', () => {
  it('carries the account and its native currency', () => {
    expect(ledgerHref('acc_cash', 'MAD')).toBe('/reports/general-ledger?account=acc_cash&currency=MAD');
  });
});

describe('ledgerCurrencyLabel', () => {
  it('never labels a MAD cash head as USD only', () => {
    expect(ledgerCurrencyLabel('MAD', false)).toBe('MAD only');
    expect(ledgerCurrencyLabel('USD', false)).toBe('USD only');
  });
});
