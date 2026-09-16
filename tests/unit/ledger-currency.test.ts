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

  it('opens a head with no native currency on every line at USD value, not on USD lines only', () => {
    // Receivables in Morocco are all MAD. Filtering to USD-denominated lines
    // showed nothing and a closing balance of zero.
    expect(resolveLedgerViewCurrency({})).toBe('REPORTING');
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
    expect(ledgerCurrencyLabel('MAD', false)).toBe('MAD lines only, in MAD');
    expect(ledgerCurrencyLabel('USD', false)).toBe('USD lines only, in USD');
    expect(ledgerCurrencyLabel('REPORTING', false)).toBe('every line at its USD value');
  });
});
