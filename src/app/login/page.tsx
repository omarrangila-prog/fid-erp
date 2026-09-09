import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { listPinAccounts } from '@/lib/auth/pin';
import { PinPad } from '@/app/login/pin-pad';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  const accounts = await listPinAccounts();

  // Nobody has set a PIN yet, so there is nothing to show a keypad for.
  if (accounts.length === 0) redirect('/login/password');

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <section className="relative hidden flex-col justify-between bg-gradient-to-br from-forest-50 via-paper to-gold-50 p-10 text-ink lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-forest-800 text-sm font-bold text-white">
            FID
          </div>
          <div>
            <p className="text-sm font-semibold">FID Trading</p>
            <p className="text-xs text-ink-subtle">Coffee Trading Management</p>
          </div>
        </div>

        <div className="max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            From green bean to ledger, in one place.
          </h1>
          <p className="text-sm leading-relaxed text-ink-muted">
            Purchase contracts, lots and batches, containers, shipments, warehouse stock, landed cost, customer
            receivables and full double-entry accounting — for Dubai and Morocco, kept strictly separate.
          </p>
        </div>

        <p className="text-[11px] text-ink-subtle">
          FID Trading L.L.C. · Dubai &nbsp;·&nbsp; FID Trading International SARL · Casablanca
        </p>
      </section>

      <section className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center justify-center gap-2.5 lg:hidden">
            <div className="grid size-8 place-items-center rounded-lg bg-forest-800 text-[11px] font-bold text-white">
              FID
            </div>
            <p className="text-sm font-semibold text-ink">FID Trading</p>
          </div>

          <PinPad accounts={accounts} />

          <p className="text-center text-[11px] leading-relaxed text-ink-subtle">
            A PIN opens only the account it belongs to. Five wrong attempts lock it for fifteen minutes; a password
            still works.{' '}
            <Link href="/login/password" className="underline hover:text-ink-muted">
              Password sign-in
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
