import { describe, expect, it } from 'vitest';
import { accountsFor } from '@/lib/cash-account-choice';

const cash = { value: 'cash', currency: 'MAD', accountType: 'CASH' as const };
const petty = { value: 'petty', currency: 'MAD', accountType: 'PETTY_CASH' as const };
const bank = { value: 'bank', currency: 'MAD', accountType: 'BANK' as const };

describe('accountsFor', () => {
  it('prefers Cash in Hand over petty cash when both exist', () => {
    const choice = accountsFor([cash, petty, bank], 'CASH', 'MAD');
    expect(choice.options.map((a) => a.value)).toEqual(['cash']);
    expect(choice.automatic).toBe('cash');
  });

  it('still offers petty cash when it is the only drawer', () => {
    const choice = accountsFor([petty, bank], 'CASH', 'MAD');
    expect(choice.options.map((a) => a.value)).toEqual(['petty']);
    expect(choice.automatic).toBe('petty');
  });

  it('offers banks for a transfer', () => {
    const choice = accountsFor([cash, petty, bank], 'BANK_TRANSFER', 'MAD');
    expect(choice.options.map((a) => a.value)).toEqual(['bank']);
    expect(choice.automatic).toBeNull();
  });
});
