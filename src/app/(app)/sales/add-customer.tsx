'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle, UserPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
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
  initialName,
  open,
  onOpenChange,
  onCreated,
  triggerLabel = 'Add Customer',
}: {
  defaultCurrency: string;
  initialName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called with the new customer so the invoice can select it immediately. */
  onCreated: (customer: { id: string; name: string; currency: string }) => void;
  triggerLabel?: string;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = open !== undefined;
  const dialogOpen = isControlled ? open : internalOpen;

  function setDialogOpen(next: boolean) {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <>
      {isControlled ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          <UserPlus />
          {triggerLabel}
        </Button>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        {dialogOpen ? (
          <AddCustomerBody
            defaultCurrency={defaultCurrency}
            initialName={initialName}
            onClose={() => setDialogOpen(false)}
            onCreated={(customer) => {
              onCreated(customer);
              setDialogOpen(false);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function AddCustomerBody({
  defaultCurrency,
  initialName,
  onClose,
  onCreated,
}: {
  defaultCurrency: string;
  initialName?: string;
  onClose: () => void;
  onCreated: (customer: { id: string; name: string; currency: string }) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    customerName: initialName?.trim() ?? '',
    primaryCurrency: defaultCurrency || 'USD',
    country: '',
    phone: '',
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (pending) return;
    setError(null);
    if (!form.customerName.trim()) {
      setError('Enter the customer’s name.');
      return;
    }

    startTransition(async () => {
      try {
        const result = await quickCreateCustomerAction(JSON.stringify(form));
        if (!result?.ok) {
          setError(result?.error || 'The customer could not be saved.');
          return;
        }
        toast.success(`${result.data.name} added.`);
        onCreated({ id: result.data.id, name: result.data.name, currency: result.data.currency });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The customer could not be saved.');
      }
    });
  }

  return (
    <DialogContent
      title="Add Customer"
      description="Saved to the customer list and selected on this invoice immediately."
    >
      <form noValidate onSubmit={submit} className="space-y-4">
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
            name="customerName"
            autoFocus
            value={form.customerName}
            onChange={(e) => set({ customerName: e.target.value })}
          />
        </Field>

        <Field label="Currency" htmlFor="newCustomerCurrency" required hint="The currency they are invoiced in.">
          <Select
            id="newCustomerCurrency"
            name="primaryCurrency"
            value={form.primaryCurrency}
            onChange={(e) => set({ primaryCurrency: e.target.value })}
          >
            <option value="USD">USD — US Dollar</option>
            <option value="MAD">MAD — Moroccan Dirham</option>
            <option value="AED">AED — UAE Dirham</option>
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" htmlFor="newCustomerCountry">
            <Input
              id="newCustomerCountry"
              name="country"
              value={form.country}
              onChange={(e) => set({ country: e.target.value })}
            />
          </Field>

          <Field label="Phone" htmlFor="newCustomerPhone">
            <Input
              id="newCustomerPhone"
              name="phone"
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
