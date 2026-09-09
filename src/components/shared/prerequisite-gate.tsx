import Link from 'next/link';
import { Check, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export type Prerequisite = {
  /** Whether this requirement is already satisfied. */
  met: boolean;
  label: string;
  description: string;
  href: string;
  actionLabel: string;
};

/**
 * Shown in place of a form that could not succeed yet.
 *
 * Raising a sales invoice needs a customer and some stock; a payment needs a
 * supplier and a bank account. Presenting the form anyway and letting the
 * person discover the empty dropdown for themselves is the sort of small
 * cruelty that makes software feel hostile, so the screen says what is missing
 * and links straight to it.
 */
export function PrerequisiteGate({
  title,
  description,
  prerequisites,
}: {
  title: string;
  description?: string;
  prerequisites: Prerequisite[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description ?? 'Two or three things have to exist first. Each link below opens the screen that adds them.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-line">
          {prerequisites.map((prerequisite) => (
            <li key={prerequisite.label} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                  prerequisite.met
                    ? 'border-teal-500 bg-teal-500 text-white'
                    : 'border-amber-300 bg-amber-50 text-amber-600',
                )}
                aria-hidden
              >
                {prerequisite.met ? <Check className="size-3" strokeWidth={3} /> : <span className="text-[11px] font-bold">!</span>}
              </span>

              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-medium', prerequisite.met ? 'text-ink-muted' : 'text-ink')}>
                  {prerequisite.label}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">{prerequisite.description}</p>
              </div>

              {prerequisite.met ? (
                <span className="shrink-0 self-center text-xs font-medium text-teal-700">Ready</span>
              ) : (
                <Link
                  href={prerequisite.href}
                  className="inline-flex shrink-0 items-center gap-1 self-center rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-navy-800 transition-colors hover:border-teal-400 hover:text-teal-700"
                >
                  {prerequisite.actionLabel}
                  <ArrowRight className="size-3.5" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** True when at least one requirement is outstanding. */
export function anyMissing(prerequisites: Prerequisite[]): boolean {
  return prerequisites.some((prerequisite) => !prerequisite.met);
}
