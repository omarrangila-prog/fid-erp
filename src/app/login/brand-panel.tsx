import { getBrand } from '@/lib/brand';

/** Faint trade lanes: routes converging on a single point, drawn once and left still. */
function TradeLines() {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 size-full opacity-[0.22]" viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" fill="none">
      <g stroke="#c5a05a" strokeWidth="1">
        <path d="M-40 760C180 690 320 520 520 430S760 250 860 120" />
        <path d="M-40 840C220 780 380 600 560 520S780 380 860 260" opacity=".6" />
        <path d="M-40 680C140 600 260 470 440 360S700 160 860 20" opacity=".45" />
      </g>
      <g fill="#c5a05a"><circle cx="520" cy="430" r="3" /><circle cx="560" cy="520" r="2.5" opacity=".7" /><circle cx="440" cy="360" r="2.5" opacity=".6" /></g>
    </svg>
  );
}

/** The left-hand brand panel shared by both sign-in screens. */
export function LoginBrandPanel(_props: { showHighlights?: boolean } = {}) {
  const brand = getBrand();
  const stats = [
    ['Landed cost', 'per unit, per shipment'],
    ['Any currency', 'rate-locked, always balanced'],
    ['Full traceability', 'order → shipment → stock → sale'],
  ];
  return (
    <section className="relative hidden flex-col justify-between overflow-hidden bg-forest-950 p-12 text-white lg:flex">
      {/* ambient light and a fine grid: depth without clutter */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(46rem_30rem_at_92%_-10%,rgba(197,160,90,0.28),transparent_62%),radial-gradient(34rem_22rem_at_-8%_108%,rgba(197,160,90,0.16),transparent_60%)]" />
      <TradeLines />

      <div className="relative flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.icon} alt="" aria-hidden className="size-12 rounded-lg" />
        <div>
          <p className="text-lg font-medium uppercase tracking-[0.3em] text-gold-200">{brand.name}</p>
          <p className="text-[11px] uppercase tracking-[0.12em] text-white/50">{brand.tagline}</p>
        </div>
      </div>

      <div className="relative max-w-lg space-y-6">
        <p className="text-5xl font-light uppercase leading-[1.04] tracking-[0.01em] text-gold-200 xl:text-6xl">{brand.loginHeadline}</p>
        <p className="max-w-md text-[15px] leading-relaxed text-white/70">{brand.description}</p>
        {(
          <dl className="grid gap-3 pt-2">
            {stats.map(([term, detail]) => (
              <div key={term} className="flex items-baseline gap-3 border-t border-white/10 pt-3">
                <dt className="w-36 shrink-0 text-sm font-semibold text-gold-400">{term}</dt>
                <dd className="text-sm text-white/65">{detail}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <p className="relative text-[11px] text-white/45">{brand.loginFooter}</p>
    </section>
  );
}

/** The compact mark shown above the form on phones. */
export function LoginBrandCompact() {
  const brand = getBrand();
  return (
    <div className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={brand.icon} alt="" aria-hidden className="size-8 rounded-lg" />
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-ink">{brand.name}</p>
    </div>
  );
}
