import Link from 'next/link';
import { cn } from '@/lib/utils';

export type PipelineStage = { key: string; label: string; count: number; quantity: string; containers: number };

/**
 * Where every shipment stands, left to right: purchased, loading, in transit,
 * arrived, received. A thin line joins the stages; each is a link to the
 * shipment list. Calm on purpose — it is a status strip, not a chart.
 */
export function TradePipeline({ stages }: { stages: PipelineStage[] }) {
  const current = stages.reduce((last, s, i) => (s.count > 0 ? i : last), -1);
  return (
    <ol className="relative grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="trade-pipeline" aria-label="Shipments by stage">
      <span aria-hidden className="absolute left-[10%] right-[10%] top-[1.05rem] hidden h-px bg-line-strong sm:block" />
      {stages.map((s, i) => (
        <li key={s.key} className="relative">
          <Link
            href="/shipments"
            className={cn(
              'group block rounded-lg border bg-surface p-3 transition-colors hover:border-forest-300',
              s.count > 0 ? 'border-line-strong' : 'border-line',
            )}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'relative z-10 grid size-5 place-items-center rounded-full border text-[10px] font-semibold',
                  s.count > 0 ? 'border-forest-900 bg-forest-900 text-white' : 'border-line-strong bg-surface text-ink-subtle',
                  i === current && 'ring-2 ring-gold-500/60 ring-offset-1',
                )}
              >
                {i + 1}
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{s.label}</span>
            </span>
            <span className="tnum mt-2 block text-2xl font-semibold tracking-tight text-ink">
              {s.count}
              <span className="ml-1 text-xs font-medium text-ink-subtle">{s.count === 1 ? 'shipment' : 'shipments'}</span>
            </span>
            <span className="tnum block truncate text-xs text-ink-subtle">
              {s.count > 0 ? `${s.quantity} · ${s.containers} ${s.containers === 1 ? 'container' : 'containers'}` : 'None'}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
