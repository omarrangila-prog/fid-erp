import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One form field: label, control, optional hint and error. Required fields are
 * marked on the label rather than relying on colour alone.
 */
export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: {
  label?: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const labelText = label ? (
    <>
      {label}
      {required ? (
        <>
          <span aria-hidden className="ml-0.5 text-red-500">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </>
  ) : null;

  const detail = error ? (
    <p className="text-xs font-medium text-red-600">{error}</p>
  ) : hint ? (
    <p className="text-xs text-ink-subtle">{hint}</p>
  ) : null;

  // With an explicit id we associate by `for`. Without one — which is most
  // controls, since ids are tedious and get forgotten — the label wraps the
  // control instead. An implicit association needs no id and cannot drift out
  // of sync, so no field can end up nameless to a screen reader.
  if (!htmlFor && labelText) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-muted">{labelText}</span>
          {children}
        </label>
        {detail}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {labelText ? (
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink-muted">
          {labelText}
        </label>
      ) : null}
      {children}
      {detail}
    </div>
  );
}

export function FieldGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-4 sm:grid-cols-2', className)} {...props} />;
}

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
