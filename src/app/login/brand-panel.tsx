import { getBrand } from '@/lib/brand';

/** The left-hand brand panel shared by both sign-in screens. */
export function LoginBrandPanel({ showHighlights = false }: { showHighlights?: boolean }) {
  const brand = getBrand();
  return (
    <section className="relative hidden flex-col justify-between bg-gradient-to-br from-forest-50 via-paper to-gold-50 p-10 text-ink lg:flex">
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-lg bg-forest-800 text-sm font-bold text-white">
          {brand.shortName}
        </div>
        <div>
          <p className="text-sm font-semibold">{brand.name}</p>
          <p className="text-xs text-ink-subtle">{brand.tagline}</p>
        </div>
      </div>

      <div className="max-w-md space-y-4">
        <p className="text-3xl font-semibold leading-tight tracking-tight">{brand.loginHeadline}</p>
        <p className="text-sm leading-relaxed text-ink-muted">{brand.description}</p>
        {showHighlights ? (
          <dl className="grid grid-cols-2 gap-4 pt-4">
            {[
              ['Traceability', 'Purchase → Shipment → Warehouse → Sale'],
              ['Costing', 'Landed cost per unit, per shipment'],
              ['Currencies', 'Any currency, rate-locked'],
              ['Accounting', 'Double-entry, always balanced'],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="text-xs font-semibold text-forest-700">{term}</dt>
                <dd className="mt-0.5 text-xs text-ink-muted">{detail}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      <p className="text-[11px] text-ink-subtle">{brand.loginFooter}</p>
    </section>
  );
}

/** The compact mark shown above the form on phones. */
export function LoginBrandCompact() {
  const brand = getBrand();
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-lg bg-forest-800 text-[11px] font-bold text-white">
        {brand.shortName}
      </div>
      <p className="text-sm font-semibold text-ink">{brand.name}</p>
    </div>
  );
}
