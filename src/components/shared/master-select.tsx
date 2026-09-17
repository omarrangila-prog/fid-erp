'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import type { ActionResult } from '@/server/actions/action-utils';

/**
 * One searchable picker for master data, with "add new" built in.
 *
 * Every voucher in the system chooses a customer, a supplier, an agent, a
 * category or an account, and before this the answer to "they are not on the
 * list yet" was a hand-written dialog per screen — four of them, each about a
 * hundred and sixty lines, each solving the same problem slightly differently.
 * The record that gets created, the errors that come back and the way the new
 * row is selected are the same everywhere, so they live here once.
 *
 * The server action stays the authority. This collects a handful of fields,
 * hands them over as JSON, and on success adds the record to the list in place
 * and selects it, so the person carries on with the voucher they were writing
 * rather than losing it to a detour through the master screen.
 */

export type QuickField = {
  name: string;
  label: string;
  kind?: 'text' | 'tel' | 'email' | 'textarea' | 'select';
  required?: boolean;
  hint?: string;
  /** For `kind: 'select'`. */
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
};

export type MasterCreateSpec<T> = {
  /** The row pinned at the top of the list, e.g. "+ Add New Supplier". */
  label: string;
  title: string;
  description?: string;
  fields: QuickField[];
  /** The field the search text pre-fills — normally the name. */
  nameField: string;
  action: (payload: string) => Promise<ActionResult<T>>;
  /** Turns what the action returns into a row of the list. */
  toOption: (created: T) => ComboOption;
  /** Announced on success; defaults to "<label> added." */
  successMessage?: (created: T) => string;
};

export function MasterSelect<T>({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled,
  id,
  invalid,
  wrap,
  autoFocus,
  create,
  onCreated,
  'aria-label': ariaLabel,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  wrap?: boolean;
  autoFocus?: boolean;
  /** Omit to get a plain searchable picker with no way to add. */
  create?: MasterCreateSpec<T>;
  /** Told about the new record, for callers that keep their own option list. */
  onCreated?: (created: T, option: ComboOption) => void;
  'aria-label'?: string;
}) {
  const [added, setAdded] = React.useState<ComboOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  // Records added here sit alongside the ones the server sent, until the next
  // navigation refreshes the page and they arrive in the list proper.
  const all = React.useMemo(() => {
    const seen = new Set(options.map((o) => o.value));
    return [...options, ...added.filter((o) => !seen.has(o.value))];
  }, [options, added]);

  return (
    <>
      <Combobox
        options={all}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        emptyText={emptyText}
        disabled={disabled}
        id={id}
        invalid={invalid}
        wrap={wrap}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        createLabel={create?.label}
        onCreate={
          create
            ? (text) => {
                setQuery(text ?? '');
                setOpen(true);
              }
            : undefined
        }
      />
      {create ? (
        <QuickCreateDialog
          open={open}
          onOpenChange={setOpen}
          spec={create}
          initialName={query}
          onCreated={(created, option) => {
            setAdded((prev) => [...prev, option]);
            onChange(option.value);
            onCreated?.(created, option);
          }}
        />
      ) : null}
    </>
  );
}

function QuickCreateDialog<T>({
  open,
  onOpenChange,
  spec,
  initialName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: MasterCreateSpec<T>;
  initialName: string;
  onCreated: (created: T, option: ComboOption) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        // Remounted each time it opens, so a previous attempt never leaves its
        // half-typed values or its error behind.
        <QuickCreateBody
          spec={spec}
          initialName={initialName}
          onClose={() => onOpenChange(false)}
          onCreated={(created, option) => {
            onCreated(created, option);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function QuickCreateBody<T>({
  spec,
  initialName,
  onClose,
  onCreated,
}: {
  spec: MasterCreateSpec<T>;
  initialName: string;
  onClose: () => void;
  onCreated: (created: T, option: ComboOption) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const formId = React.useId().replace(/:/g, '');

  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of spec.fields) {
      initial[field.name] =
        field.name === spec.nameField ? initialName : (field.defaultValue ?? '');
    }
    return initial;
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    const missing = spec.fields.find((f) => f.required && !values[f.name]?.trim());
    if (missing) {
      setError(`Enter the ${missing.label.toLowerCase()}.`);
      return;
    }

    const payload: Record<string, string> = {};
    for (const field of spec.fields) payload[field.name] = (values[field.name] ?? '').trim();

    startTransition(async () => {
      const result = await spec.action(JSON.stringify(payload));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const option = spec.toOption(result.data);
      toast.success(spec.successMessage?.(result.data) ?? `${option.label} added.`);
      onCreated(result.data, option);
    });
  }

  return (
    <DialogContent title={spec.title} description={spec.description}>
      <form id={formId} onSubmit={submit} className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {spec.fields.map((field, index) => {
          const inputId = `${formId}-${field.name}`;
          const set = (next: string) => setValues((prev) => ({ ...prev, [field.name]: next }));
          return (
            <Field key={field.name} label={field.label} htmlFor={inputId} required={field.required} hint={field.hint}>
              {field.kind === 'textarea' ? (
                <Textarea id={inputId} rows={3} value={values[field.name] ?? ''} onChange={(e) => set(e.target.value)} />
              ) : field.kind === 'select' ? (
                <Select id={inputId} value={values[field.name] ?? ''} onChange={(e) => set(e.target.value)}>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={inputId}
                  type={field.kind === 'tel' ? 'tel' : field.kind === 'email' ? 'email' : 'text'}
                  autoFocus={index === 0}
                  value={values[field.name] ?? ''}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            </Field>
          );
        })}

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
