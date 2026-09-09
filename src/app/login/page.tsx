import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { LoginForm } from '@/app/login/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      {/* Brand panel — hidden on phones, where it would just push the form down. */}
      <section className="relative hidden flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-teal-500 text-sm font-bold text-navy-950">
            FID
          </div>
          <div>
            <p className="text-sm font-semibold">FID Trading</p>
            <p className="text-xs text-navy-400">Coffee Trading Management</p>
          </div>
        </div>

        <div className="max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            From green bean to ledger, in one place.
          </h1>
          <p className="text-sm leading-relaxed text-navy-300">
            Purchase contracts, lots and batches, containers, shipments, warehouse stock, landed cost, customer
            receivables and full double-entry accounting — for Dubai and Morocco, kept strictly separate.
          </p>
          <dl className="grid grid-cols-2 gap-4 pt-4">
            {[
              ['Traceability', 'Lot → Batch → Container → Warehouse'],
              ['Costing', 'Landed cost per KG and per bag'],
              ['Currencies', 'USD, AED and MAD, rate-locked'],
              ['Accounting', 'Double-entry, always balanced'],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="text-xs font-semibold text-teal-300">{term}</dt>
                <dd className="mt-0.5 text-xs text-navy-400">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="text-[11px] text-navy-500">
          FID Trading L.L.C. · Dubai &nbsp;·&nbsp; FID Trading International SARL · Casablanca
        </p>
      </section>

      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 lg:hidden">
            <div className="flex items-center gap-2.5">
              <div className="grid size-8 place-items-center rounded-lg bg-navy-900 text-[11px] font-bold text-teal-300">
                FID
              </div>
              <p className="text-sm font-semibold text-ink">FID Trading</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight text-ink">Sign in</h2>
            <p className="text-sm text-ink-muted">Use the account your administrator created for you.</p>
          </div>

          <LoginForm />

          <p className="text-xs leading-relaxed text-ink-subtle">
            Access is restricted to the companies assigned to your account. Sessions expire automatically and every
            financial action is recorded in the audit trail.
          </p>
        </div>
      </section>
    </main>
  );
}
