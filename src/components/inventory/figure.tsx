import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/**
 * One headline figure on the stock pages: the company's currency first, the
 * USD equivalent under it. Pre-formatted on the server; a test id so the
 * browser suite can read the very figure the client sees.
 */
export function Figure({
  label,
  value,
  equivalent,
  sub,
  tone = 'default',
  testId,
}: {
  label: string;
  value: string;
  equivalent?: { text: string; title: string } | null;
  sub?: string;
  tone?: 'default' | 'positive' | 'negative';
  testId?: string;
}) {
  return (
    <Card className="h-full p-4" data-testid={testId}>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p
        data-figure-value
        className={cn(
          'tnum mt-1.5 text-lg font-semibold tracking-tight sm:text-xl',
          tone === 'positive' && 'text-emerald-700',
          tone === 'negative' && 'text-red-600',
        )}
      >
        {value}
      </p>
      {equivalent ? (
        <p className="tnum text-[11px] text-ink-subtle" title={equivalent.title}>
          {equivalent.text}
        </p>
      ) : null}
      {sub ? <p className="mt-0.5 text-xs text-ink-subtle">{sub}</p> : null}
    </Card>
  );
}
