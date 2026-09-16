'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { quickCreateExpenseCategoryAction } from '@/server/actions/master-actions';

export type CreatedExpenseCategory = {
  value: string;
  label: string;
  hint?: string;
  keywords?: string;
  capitaliseByDefault: boolean;
  kind: 'SHIPMENT' | 'GENERAL';
};

/**
 * Add a category without leaving the expense voucher.
 *
 * New kinds of cost show up after the company is already trading. The name is
 * enough; the code is issued on the server, and the shipment/general type is
 * taken from the form already being filled in.
 */
export function AddExpenseCategoryDialog({
  open,
  onOpenChange,
  kind,
  initialName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'SHIPMENT' | 'GENERAL';
  /** Search text typed in the category list, if any. */
  initialName?: string;
  onCreated: (category: CreatedExpenseCategory) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddExpenseCategoryBody
          kind={kind}
          initialName={initialName}
          onClose={() => onOpenChange(false)}
          onCreated={(category) => {
            onCreated(category);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function AddExpenseCategoryBody({
  kind,
  initialName,
  onClose,
  onCreated,
}: {
  kind: 'SHIPMENT' | 'GENERAL';
  initialName?: string;
  onClose: () => void;
  onCreated: (category: CreatedExpenseCategory) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(initialName ?? '');
  const [description, setDescription] = React.useState('');

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (pending) return;
    setError(null);
    if (!name.trim()) {
      setError('Enter the category name.');
      return;
    }

    startTransition(async () => {
      const result = await quickCreateExpenseCategoryAction(
        JSON.stringify({ name: name.trim(), description: description.trim(), kind }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${result.data.name} added.`);
      onCreated({
        value: result.data.id,
        label: result.data.name,
        hint: result.data.capitaliseByDefault ? 'Landed cost' : 'Period cost',
        keywords: result.data.code,
        capitaliseByDefault: result.data.capitaliseByDefault,
        kind: result.data.kind,
      });
    });
  }

  return (
    <DialogContent
    title="Add New Category"
    description={
        kind === 'SHIPMENT'
          ? 'A cost of one consignment. You can still choose whether it raises the coffee’s landed cost.'
          : 'A running cost of the business, not one consignment.'
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Category name" htmlFor="newCategoryName" required>
          <Input
            id="newCategoryName"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Warehouse rent"
          />
        </Field>

        <Field label="Description" htmlFor="newCategoryDescription" hint="Optional.">
          <Textarea
            id="newCategoryDescription"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </Field>

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
