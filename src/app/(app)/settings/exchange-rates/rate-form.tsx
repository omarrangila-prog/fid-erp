'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { CURRENCIES } from '@/lib/currencies';
import { todayInputValue } from '@/lib/format';
import { saveExchangeRateAction } from '@/server/actions/company-actions';

export function RateForm({ suggested }: { suggested: string[] }) {
  const router = useRouter();
  const [currency, setCurrency] = React.useState(suggested[0] ?? 'EUR');
  const [rate, setRate] = React.useState('');
  const [date, setDate] = React.useState(todayInputValue());
  const [saving, setSaving] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await saveExchangeRateAction({ currency, rate, effectiveDate: date });
      if (result.ok) {
        toast.success(`1 USD = ${rate} ${currency} saved.`);
        setRate('');
        router.refresh();
      } else toast.error(result.error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FieldGroup className="sm:grid-cols-3">
        <Field label="Currency" htmlFor="rate-currency">
          <Select id="rate-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([...suggested, ...CURRENCIES.map((c) => c.code)])]
              .filter((c) => c !== 'USD')
              .map((code) => (
                <option key={code} value={code}>
                  {code} — {CURRENCIES.find((c) => c.code === code)?.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={`1 USD =`} htmlFor="rate-value" hint={`How many ${currency} one US dollar buys.`}>
          <Input id="rate-value" value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder="3.6725" className="tnum text-right" required />
        </Field>
        <Field label="Starting from" htmlFor="rate-date">
          <Input id="rate-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={saving || !rate}>
        {saving ? 'Saving…' : 'Save rate'}
      </Button>
    </form>
  );
}
