'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

export function AccountPicker({
  accounts,
  selectedId,
  from,
  to,
}: {
  accounts: Array<{ id: string; code: string; name: string; type: string }>;
  selectedId: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [account, setAccount] = React.useState<string | null>(selectedId || null);
  const [fromDate, setFrom] = React.useState(from);
  const [toDate, setTo] = React.useState(to);

  function apply() {
    const params = new URLSearchParams();
    if (account) params.set('account', account);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
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
          onChange={setAccount}
          placeholder="Choose an account…"
        />
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
