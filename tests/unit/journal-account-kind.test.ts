import { describe, expect, it } from 'vitest';
import { JOURNAL_ACCOUNT_KINDS, resolveJournalAccountKind } from '@/lib/services/journal-account-kind';
import { REPORT_GROUPS } from '@/lib/constants';

describe('journal account kinds', () => {
  it('maps Personal / Current Account onto a balance-sheet asset, not the P&L', () => {
    const kind = resolveJournalAccountKind('PERSONAL');
    expect(kind?.label).toMatch(/personal \/ current/i);
    expect(kind?.type).toBe('ASSET');
    expect(kind?.reportGroup).toBe(REPORT_GROUPS.CURRENT_ASSET);
  });

  it('maps Loan / Advance the same way — one head, both directions', () => {
    const kind = resolveJournalAccountKind('LOAN');
    expect(kind?.type).toBe('ASSET');
    expect(kind?.reportGroup).toBe(REPORT_GROUPS.CURRENT_ASSET);
  });

  it('does not put income or expense kinds on the balance sheet current-asset group', () => {
    expect(resolveJournalAccountKind('INCOME')?.type).toBe('INCOME');
    expect(resolveJournalAccountKind('EXPENSE')?.type).toBe('EXPENSE');
    expect(resolveJournalAccountKind('INCOME')?.reportGroup).not.toBe(REPORT_GROUPS.CURRENT_ASSET);
  });

  it('lists every type the Add Account dialog offers', () => {
    const values = JOURNAL_ACCOUNT_KINDS.map((kind) => kind.value);
    expect(values).toEqual([
      'PERSONAL',
      'LOAN',
      'CASH_BANK',
      'CUSTOMER',
      'SUPPLIER',
      'OTHER_ASSET',
      'OTHER_LIABILITY',
      'INCOME',
      'EXPENSE',
      'EQUITY',
      'OTHER',
    ]);
  });

  it('rejects a kind the form did not offer', () => {
    expect(resolveJournalAccountKind('NOT_A_KIND')).toBeNull();
  });
});
