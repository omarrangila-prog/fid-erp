'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Combobox } from '@/components/ui/combobox';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

export function AccountPicker({
  accounts,
  selectedId,
  from,
  to,
  currency,
}: {
  accounts: Array<{ id: string; code: string; name: string; type: string; nativeCurrency: string }>;
  selectedId: string;
  from: string;
  to: string;
  currency: string;
}) {
  const router = useRouter();
  const [account, setAccount] = React.useState<string | null>(selectedId || null);
  const [fromDate, setFrom] = React.useState(from);
  const [toDate, setTo] = React.useState(to);
  const [ccy, setCcy] = React.useState(currency || 'USD');

  function chooseAccount(id: string | null) {
    setAccount(id);
    const found = accounts.find((row) => row.id === id);
    if (found) setCcy(found.nativeCurrency);
  }

  function apply() {
    const params = new URLSearchParams();
    if (account) params.set('account', account);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (ccy) params.set('currency', ccy);
    router.push(`/reports/general-ledger?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Account" className="min-w-64 flex-1">
        <Combobox
          options={accounts.map((a) => ({
            value: a.id,
            label: `${a.code} · ${a.name}`,
            hint: a.type.toLowerCase(),
            keywords: a.code,
          }))}
          value={account}
          onChange={chooseAccount}
          placeholder="Choose an account…"
        />
      </Field>
      <Field label="Currency" className="w-40">
        <Select value={ccy} onChange={(e) => setCcy(e.target.value)}>
          <option value="REPORTING">Every line at USD value</option>
          <option value="ALL">All — listed separately</option>
          <option value="USD">USD lines only</option>
          <option value="MAD">MAD lines only</option>
          <option value="AED">AED lines only</option>
        </Select>
      </Field>
      <Field label="From" className="w-40">
        <Input type="date" value={fromDate} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="To" className="w-40">
        <Input type="date" value={toDate} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Button variant="outline" onClick={apply}>
        Apply
      </Button>
    </div>
  );
}
