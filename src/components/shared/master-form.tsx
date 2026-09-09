'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Select, MoneyInput } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import type { MasterFormState } from '@/server/actions/master-actions';

/**
 * A spec-driven form for master records.
 *
 * All seven master modules — customers, suppliers, coffee, warehouses, agents,
 * shipping lines and expense categories — differ only in their fields, so they
 * share this one implementation rather than seven near-identical forms. The
 * server action remains the authority: this renders the fields and surfaces the
 * per-field errors the action sends back.
 */

export type FieldSpec =
  | {
      kind: 'text' | 'email' | 'tel' | 'number' | 'money' | 'percent' | 'date';
      name: string;
      label: string;
      required?: boolean;
      hint?: string;
      placeholder?: string;
      currency?: string;
      full?: boolean;
    }
  | { kind: 'textarea'; name: string; label: string; required?: boolean; hint?: string; placeholder?: string; full?: boolean }
  | {
      kind: 'select';
      name: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      required?: boolean;
      hint?: string;
      full?: boolean;
    }
  | { kind: 'checkbox'; name: string; label: string; hint?: string; full?: boolean }
  | {
      /**
       * A grouped set of checkboxes posting `name[]`. Used for role
       * assignment, company access and permission grants, where the answer is
       * genuinely a set rather than one choice.
       */
      kind: 'multicheck';
      name: string;
      label: string;
      options: Array<{ value: string; label: string; hint?: string; group?: string }>;
      hint?: string;
      columns?: 1 | 2 | 3;
      full?: boolean;
    }
  | { kind: 'section'; title: string; description?: string };

export function MasterFormSheet({
  open,
  onOpenChange,
  title,
  description,
  fields,
  defaults,
  action,
  submitLabel = 'Save',
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  fields: FieldSpec[];
  defaults?: Record<string, string | number | boolean | null | undefined>;
  action: (prev: MasterFormState, formData: FormData) => Promise<MasterFormState>;
  submitLabel?: string;
  onSaved?: (id: string) => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onOpenChange(false);
      onSaved?.(state.id);
      router.refresh();
    }
  }, [state, onOpenChange, onSaved, router]);

  const errors = state && !state.ok ? (state.errors ?? {}) : {};

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => formRef.current?.requestSubmit()} loading={pending}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <form ref={formRef} action={formAction} className="space-y-5">
        {state && !state.ok ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((field, index) => {
            if (field.kind === 'section') {
              return (
                <div key={`section-${index}`} className="sm:col-span-2">
                  <div className={cn('border-t border-line pt-4', index === 0 && 'border-t-0 pt-0')}>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{field.title}</h4>
                    {field.description ? (
                      <p className="mt-0.5 text-xs text-ink-muted">{field.description}</p>
                    ) : null}
                  </div>
                </div>
              );
            }

            const defaultValue = defaults?.[field.name];
            const error = errors[field.name];
            const wrapperClass = field.full ? 'sm:col-span-2' : undefined;

            if (field.kind === 'multicheck') {
              const selected = new Set(
                String(defaultValue ?? '')
                  .split(',')
                  .filter(Boolean),
              );
              const groups = new Map<string, typeof field.options>();
              for (const option of field.options) {
                const key = option.group ?? '';
                groups.set(key, [...(groups.get(key) ?? []), option]);
              }

              return (
                <div key={field.name} className={cn('space-y-2', wrapperClass ?? 'sm:col-span-2')}>
                  <p className="text-xs font-medium text-ink-muted">{field.label}</p>
                  {field.hint ? <p className="text-xs text-ink-subtle">{field.hint}</p> : null}
                  {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}

                  <div className="max-h-80 space-y-4 overflow-y-auto rounded-lg border border-line bg-forest-50/30 p-3">
                    {[...groups.entries()].map(([groupName, options]) => (
                      <div key={groupName || 'ungrouped'} className="space-y-1.5">
                        {groupName ? (
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                            {groupName}
                          </p>
                        ) : null}
                        <div
                          className={cn(
                            'grid gap-1.5',
                            field.columns === 3
                              ? 'sm:grid-cols-3'
                              : field.columns === 1
                                ? 'grid-cols-1'
                                : 'sm:grid-cols-2',
                          )}
                        >
                          {options.map((option) => (
                            <label
                              key={option.value}
                              className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface"
                            >
                              <input
                                type="checkbox"
                                name={`${field.name}[]`}
                                value={option.value}
                                defaultChecked={selected.has(option.value)}
                                className="mt-0.5 size-4 shrink-0 accent-gold-600"
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-ink">{option.label}</span>
                                {option.hint ? (
                                  <span className="block truncate text-[11px] text-ink-subtle">{option.hint}</span>
                                ) : null}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }

            if (field.kind === 'checkbox') {
              return (
                <div key={field.name} className={cn('flex items-start gap-2.5 pt-1', wrapperClass)}>
                  <input
                    id={field.name}
                    name={field.name}
                    type="checkbox"
                    value="true"
                    defaultChecked={Boolean(defaultValue)}
                    className="mt-0.5 size-4 shrink-0 accent-gold-600"
                  />
                  <label htmlFor={field.name} className="text-sm text-ink">
                    {field.label}
                    {field.hint ? <span className="block text-xs text-ink-subtle">{field.hint}</span> : null}
                  </label>
                </div>
              );
            }

            return (
              <Field
                key={field.name}
                label={field.label}
                htmlFor={field.name}
                required={'required' in field ? field.required : false}
                hint={'hint' in field ? field.hint : undefined}
                error={error}
                className={wrapperClass}
              >
                {field.kind === 'select' ? (
                  <Select
                    id={field.name}
                    name={field.name}
                    defaultValue={defaultValue == null ? '' : String(defaultValue)}
                    aria-invalid={Boolean(error)}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : field.kind === 'textarea' ? (
                  <Textarea
                    id={field.name}
                    name={field.name}
                    placeholder={field.placeholder}
                    defaultValue={defaultValue == null ? '' : String(defaultValue)}
                    aria-invalid={Boolean(error)}
                  />
                ) : field.kind === 'money' ? (
                  <MoneyInput
                    id={field.name}
                    name={field.name}
                    currency={field.currency}
                    placeholder={field.placeholder ?? '0.00'}
                    defaultValue={defaultValue == null ? '' : String(defaultValue)}
                    aria-invalid={Boolean(error)}
                  />
                ) : (
                  <Input
                    id={field.name}
                    name={field.name}
                    type={field.kind === 'date' ? 'date' : field.kind === 'email' ? 'email' : field.kind === 'tel' ? 'tel' : 'text'}
                    inputMode={field.kind === 'number' || field.kind === 'percent' ? 'decimal' : undefined}
                    placeholder={field.placeholder}
                    defaultValue={defaultValue == null ? '' : String(defaultValue)}
                    aria-invalid={Boolean(error)}
                    className={field.kind === 'number' || field.kind === 'percent' ? 'tnum text-right' : undefined}
                  />
                )}
              </Field>
            );
          })}
        </div>
      </form>
    </Sheet>
  );
}

export const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

export const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'MAD', label: 'MAD — Moroccan Dirham' },
];
