'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Combobox } from '@/components/ui/combobox';
import { FilterApply, FilterBar, FilterCell, FilterDate, FilterSelect } from '@/components/shared/filter-bar';
import { transactionCurrencies } from '@/lib/company-currencies';

export function AccountPicker({
  accounts,
  selectedId,
  from,
  to,
  currency,
  localCurrency,
}: {
  accounts: Array<{ id: string; code: string; name: string; type: string; nativeCurrency: string }>;
  selectedId: string;
  from: string;
  to: string;
  currency: string;
  localCurrency: string;
}) {
  const router = useRouter();
  const [account, setAccount] = React.useState<string | null>(selectedId || null);
  const [fromDate, setFrom] = React.useState(from);
  const [toDate, setTo] = React.useState(to);
  const [ccy, setCcy] = React.useState(currency || 'USD');
  const dirty = (account ?? 'all') !== (selectedId || 'all') || fromDate !== from || toDate !== to || ccy !== (currency || 'USD');

  function chooseAccount(id: string | null) {
    setAccount(id);
    const found = accounts.find((row) => row.id === id);
    if (found) setCcy(found.nativeCurrency);
  }

  function apply() {
    const params = new URLSearchParams();
    if (account) params.set('account', account);
    else params.set('account', 'all');
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (ccy) params.set('currency', ccy);
    router.push(`/reports/general-ledger?${params.toString()}`);
  }

  return (
    <FilterBar>
      <FilterCell label="Account" className="md:min-w-72 md:flex-1">
        <Combobox
          options={[
            // The whole book, account by account — the printed general ledger.
            { value: 'all', label: 'All accounts', hint: 'every account with activity, grouped', keywords: 'all every book' },
            ...accounts.map((a) => ({
              value: a.id,
              label: a.name,
              hint: a.type.toLowerCase(),
              keywords: a.code,
            })),
          ]}
          value={account}
          onChange={chooseAccount}
          placeholder="Choose an account…"
          className="h-7 rounded-none border-0 bg-transparent px-0 font-semibold hover:border-0 focus:ring-0 [&>span]:text-ink"
        />
      </FilterCell>
      <FilterCell label="Currency" className="md:w-56">
        <FilterSelect value={ccy} onChange={(e) => setCcy(e.target.value)}>
          <option value="REPORTING">Every line at USD value</option>
          <option value="ALL">All — listed separately</option>
          {[
            ...new Set([
              'USD',
              ...transactionCurrencies(localCurrency, currency === 'REPORTING' || currency === 'ALL' ? null : currency),
            ]),
          ].map((code) => (
            <option key={code} value={code}>
              {code} lines only
            </option>
          ))}
        </FilterSelect>
      </FilterCell>
      <FilterCell label="From" className="md:w-44">
        <FilterDate value={fromDate} onChange={setFrom} empty="Beginning" aria-label="From" />
      </FilterCell>
      <FilterCell label="To" className="md:w-44">
        <FilterDate value={toDate} onChange={setTo} empty="Today" aria-label="To" />
      </FilterCell>
      <FilterApply dirty={dirty} onClick={apply} />
    </FilterBar>
  );
}
