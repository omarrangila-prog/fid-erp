import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { anyPinAccount } from '@/lib/auth/pin';
import { isDemoMode } from '@/lib/demo/mode';
import { DemoEntry } from '@/app/login/demo-entry';
import { PinPad } from '@/app/login/pin-pad';
import { LoginBrandCompact, LoginBrandPanel } from '@/app/login/brand-panel';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  // A brand-new installation has no PINs yet: the owner starts with a password.
  if (!(await anyPinAccount())) redirect('/login/password');

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel />

      <section className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex justify-center lg:hidden">
            <LoginBrandCompact />
          </div>

          <PinPad />
          {isDemoMode() ? <DemoEntry /> : null}
        </div>
      </section>
    </main>
  );
}
