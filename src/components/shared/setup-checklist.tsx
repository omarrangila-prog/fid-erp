import Link from 'next/link';
import { Check, ArrowRight, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { SetupStep } from '@/lib/services/setup';

/** A step, stripped of the permission code, ready to cross to the client. */
export type ChecklistStep = Omit<SetupStep, 'permission'>;

function Progress({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy-100">
        <div
          className="h-full rounded-full bg-teal-500 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tnum shrink-0 text-xs font-medium text-ink-muted">
        {completed} of {total}
      </span>
    </div>
  );
}

function StepRow({ step }: { step: ChecklistStep }) {
  const body = (
    <>
      <span
        className={cn(
          'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
          step.done ? 'border-teal-500 bg-teal-500 text-white' : 'border-line-strong bg-surface text-transparent',
        )}
        aria-hidden
      >
        {step.done ? <Check className="size-3" strokeWidth={3} /> : <Circle className="size-2 fill-navy-200 text-navy-200" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm font-medium', step.done ? 'text-ink-muted line-through' : 'text-ink')}>
          {step.title}
        </span>
        <span className="mt-0.5 block text-xs text-ink-muted">{step.description}</span>
      </span>

      {step.done ? (
        <span className="tnum shrink-0 self-center rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700">
          {step.count}
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 self-center rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-navy-800 transition-colors group-hover:border-teal-400 group-hover:text-teal-700">
          {step.actionLabel}
          <ArrowRight className="size-3.5" />
        </span>
      )}
    </>
  );

  return (
    <li>
      <Link
        href={step.href}
        className="group flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-navy-50/70"
      >
        {body}
      </Link>
    </li>
  );
}

/**
 * The "what do I do next" panel.
 *
 * Shown on the dashboard until the company has actually started trading, and
 * permanently available at /getting-started. Steps the signed-in user has no
 * permission to carry out are filtered out on the server before they get here.
 */
export function SetupChecklist({
  steps,
  completed,
  total,
  title = 'Get FID ready for your business',
  description = 'Nine short steps. Each one is a normal screen — nothing here is a wizard you have to finish in one sitting.',
}: {
  steps: ChecklistStep[];
  completed: number;
  total: number;
  title?: string;
  description?: string;
}) {
  const setup = steps.filter((s) => s.phase === 'setup');
  const trading = steps.filter((s) => s.phase === 'trading');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <div className="pt-2">
          <Progress completed={completed} total={total} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        {setup.length > 0 ? (
          <section>
            <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              First, set up your records
            </h3>
            <ul className="divide-y divide-line/70">
              {setup.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ul>
          </section>
        ) : null}

        {trading.length > 0 ? (
          <section>
            <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Then, run a trade end to end
            </h3>
            <ul className="divide-y divide-line/70">
              {trading.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
