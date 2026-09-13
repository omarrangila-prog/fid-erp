'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle, UserPlus } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { quickCreateCustomerAction } from '@/server/actions/master-actions';

/**
 * Add a customer without leaving the invoice.
 *
 * A new customer walks in and buys something. Abandoning a half-filled
 * invoice, going to the customer master, coming back and starting again is the
 * friction the client asked to be rid of.
 *
 * It asks only what an invoice needs. Everything else — address, credit limit,
 * contact — can be filled in later on the customer's own page, and a sale is
 * not the moment to be asking for it.
 */
export function AddCustomer({
  defaultCurrency,
  onCreated,
}: {
  defaultCurrency: string;
  /** Called with the new customer so the invoice can select it immediately. */
  onCreated: (customer: { id: string; name: string; currency: string }) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <UserPlus />
        New customer
      </Button>

      {open ? (
        <AddCustomerSheet
          defaultCurrency={defaultCurrency}
          onClose={() => setOpen(false)}
          onCreated={(customer) => {
            onCreated(customer);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function AddCustomerSheet({
  defaultCurrency,
  onClose,
  onCreated,
}: {
  defaultCurrency: string;
  onClose: () => void;
  onCreated: (customer: { id: string; name: string; currency: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    customerName: '',
    primaryCurrency: defaultCurrency,
    country: '',
    phone: '',
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  function submit() {
    setError(null);
    if (!form.customerName.trim()) {
      setError('Enter the customer’s name.');
      return;
    }

    startTransition(async () => {
      const result = await quickCreateCustomerAction(JSON.stringify(form));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${result.data.name} added.`);
      onCreated(result.data);
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title="New customer"
      description="Just enough to raise the invoice. The rest can be filled in later."
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Add and select
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Customer name" htmlFor="newCustomerName" required>
          <Input
            id="newCustomerName"
            autoFocus
            value={form.customerName}
            onChange={(e) => set({ customerName: e.target.value })}
          />
        </Field>

        <Field label="Currency" htmlFor="newCustomerCurrency" required hint="The currency they are invoiced in.">
          <Select
            id="newCustomerCurrency"
            value={form.primaryCurrency}
            onChange={(e) => set({ primaryCurrency: e.target.value })}
          >
            <option value="USD">USD — US Dollar</option>
            <option value="AED">AED — UAE Dirham</option>
            <option value="MAD">MAD — Moroccan Dirham</option>
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" htmlFor="newCustomerCountry">
            <Input id="newCustomerCountry" value={form.country} onChange={(e) => set({ country: e.target.value })} />
          </Field>

          <Field label="Phone" htmlFor="newCustomerPhone">
            <Input id="newCustomerPhone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
        </div>

      </div>
    </Sheet>
  );
}
