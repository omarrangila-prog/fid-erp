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
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest-700">{getBrand().name} · platform</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">Customers</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Create, plan, switch off and re-key customers. Counts and health only — a customer’s books, names and balances are not shown here, and every action is recorded.
        </p>
      </header>
      <PlatformConsole
        tenants={tenants.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), lastLoginAt: t.lastLoginAt?.toISOString() ?? null }))}
        countries={COUNTRIES.map((c) => c.name)}
        templates={TEMPLATE_LIST.map((t) => ({ key: t.key, label: t.label }))}
        plans={Object.values(PLANS).map((p) => ({ key: p.key, label: p.label }))}
      />
    </main>
  );
}
