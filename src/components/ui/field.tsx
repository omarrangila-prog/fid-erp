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
      <div data-field-error={error ? 'true' : undefined} className={cn('flex flex-col gap-1.5', className)}>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-muted">{labelText}</span>
          {children}
        </label>
        {detail}
      </div>
    );
  }

  return (
    <div data-field-error={error ? 'true' : undefined} className={cn('flex flex-col gap-1.5', className)}>
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
  collapsible,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Folds the section away until asked for.
   *
   * For information the business does not have yet. A shipping line and a
   * port of loading are unknown the day a contract is agreed, and showing
   * empty boxes for them makes the form look unfinished and the person
   * filling it feel they have missed something.
   *
   * `<details>` rather than state: it works before hydration, the browser
   * handles the keyboard, and find-in-page opens it.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  if (collapsible) {
    return (
      <details open={defaultOpen} className={cn('group rounded-lg border border-line bg-canvas', className)}>
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
          <span>
            <span className="block text-sm font-semibold text-ink">{title}</span>
            {description ? <span className="mt-0.5 block text-xs text-ink-muted">{description}</span> : null}
          </span>
          <span className="shrink-0 text-xs font-medium text-forest-700 group-open:hidden">Show</span>
          <span className="hidden shrink-0 text-xs font-medium text-forest-700 group-open:inline">Hide</span>
        </summary>
        <div className="space-y-4 border-t border-line px-4 py-4">{children}</div>
      </details>
    );
  }

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
