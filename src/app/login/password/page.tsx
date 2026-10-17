import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import Link from 'next/link';
import { isDemoMode } from '@/lib/demo/mode';
import { DemoEntry } from '@/app/login/demo-entry';
import { LoginForm } from '@/app/login/password/login-form';
import { LoginBrandCompact, LoginBrandPanel } from '@/app/login/brand-panel';

export const metadata: Metadata = { title: 'Sign in with a password' };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <LoginBrandPanel showHighlights />

      <section className="login-dark flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 lg:hidden">
            <LoginBrandCompact />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight text-ink">Sign in</h2>
            <p className="text-sm text-ink-muted">Use the account your administrator created for you.</p>
            <p className="pt-1 text-sm">
              <Link href="/login" className="font-medium text-forest-700 hover:underline">
                Sign in with a PIN instead
              </Link>
            </p>
          </div>

          <LoginForm />
          {isDemoMode() ? <DemoEntry /> : null}

          <p className="text-xs leading-relaxed text-ink-subtle">
            Access is restricted to the companies assigned to your account. Sessions expire automatically and every
            financial action is recorded in the audit trail.
          </p>
        </div>
      </section>
    </main>
  );
}
