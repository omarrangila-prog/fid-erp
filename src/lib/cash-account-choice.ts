/**
 * Which cash/bank accounts a voucher may land in, given how the money moved.
 *
 * "Cash" means the drawer — the Cash in Hand account for that currency — so
 * when there is exactly one, it is chosen for the user and there is nothing
 * to pick. A bank transfer or cheque goes to a bank account, of which there
 * may be several, so those are still offered.
 */
export type AccountChoice = {
  value: string;
  currency: string;
  accountType: 'CASH' | 'PETTY_CASH' | 'BANK';
};

export function accountsFor<T extends AccountChoice>(
  accounts: T[],
  paymentMethod: string,
  currency: string,
): { options: T[]; automatic: string | null } {
  const inCurrency = accounts.filter((a) => a.currency === currency);
  const wantCash = paymentMethod === 'CASH';
  const matching = wantCash
    ? inCurrency.filter((a) => a.accountType === 'CASH' || a.accountType === 'PETTY_CASH')
    : inCurrency.filter((a) => a.accountType === 'BANK');

  // Prefer Cash in Hand over petty cash when both exist — they are not two
  // places to put the same drawer, and offering both made people hesitate.
  const drawers = matching.filter((a) => a.accountType === 'CASH');
  const preferred = wantCash && drawers.length > 0 ? drawers : matching;
  const options = preferred.length > 0 ? preferred : inCurrency;
  const automatic = wantCash && options.length === 1 ? options[0].value : null;
  return { options, automatic };
}
