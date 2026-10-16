import type { Metadata } from 'next';
import { requireDeveloperPage } from '@/lib/auth/developer';
import { listTenants } from '@/lib/services/platform';
import { COUNTRIES } from '@/lib/countries';
import { TEMPLATE_LIST } from '@/lib/templates';
import { PLANS } from '@/lib/entitlements';
import { getBrand } from '@/lib/brand';
import { PlatformConsole } from '@/app/platform/console';

export const metadata: Metadata = { title: 'Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformPage() {
  await requireDeveloperPage();
  const tenants = await listTenants();
  const brand = getBrand();
  return (
    <div className="min-h-dvh bg-paper">
      <div className="border-b border-forest-800 bg-forest-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={brand.icon} alt="" aria-hidden className="size-8 rounded-md" />
            <span className="rounded border border-gold-500/60 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-300" data-testid="platform-badge">
              {brand.name} platform admin
            </span>
          </div>
          <a href="/dashboard" className="text-xs text-white/70 hover:text-white">Back to workspace</a>
        </div>
      </div>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Customers</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Create, plan, switch off and re-key customers. Counts and health only — a customer’s books, names and balances are not shown here, and every action is recorded.
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Customers', tenants.length],
          ['Active', tenants.filter((t) => t.status === 'ACTIVE').length],
          ['Companies', tenants.reduce((n, t) => n + t.companies.length, 0)],
          ['Users', tenants.reduce((n, t) => n + t.users, 0)],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-lg border border-line-strong/70 bg-surface p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">{k}</dt>
            <dd className="tnum mt-1 text-2xl font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <PlatformConsole
        tenants={tenants.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), lastLoginAt: t.lastLoginAt?.toISOString() ?? null }))}
        countries={COUNTRIES.map((c) => c.name)}
        templates={TEMPLATE_LIST.map((t) => ({ key: t.key, label: t.label }))}
        plans={Object.values(PLANS).map((p) => ({ key: p.key, label: p.label }))}
      />
      </main>
    </div>
  );
}
