import { AlertCircle } from 'lucide-react';
import { describeErrorCount } from '@/lib/focus-first-error';

/**
 * What went wrong when a form would not save.
 *
 * Says how many fields need attention as well as what happened, because
 * "please correct the highlighted fields" does not tell you whether that is
 * one field or nine — and that is the difference between finishing now and
 * giving up. The form scrolls to the first one; this says how many follow.
 */
export function FormError({
  message,
  fieldErrors,
}: {
  message: string | null;
  fieldErrors?: Record<string, string>;
}) {
  if (!message) return null;
  const count = fieldErrors ? describeErrorCount(fieldErrors) : '';

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>
        {message}
        {count ? <span className="mt-0.5 block font-medium">{count}</span> : null}
      </span>
    </div>
  );
}
