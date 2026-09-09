'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Delete, KeyRound, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pinLoginAction } from '@/server/actions/session-actions';

export type PinAccount = {
  id: string;
  name: string;
  role: string;
  companies: Array<{ name: string; country: string; code: string }>;
};

function flagFor(country: string): string {
  const name = country.toLowerCase();
  if (name.includes('emirat') || name.includes('uae') || name.includes('dubai')) return '\u{1F1E6}\u{1F1EA}';
  if (name.includes('morocco') || name.includes('maroc')) return '\u{1F1F2}\u{1F1E6}';
  return '';
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * PIN sign-in.
 *
 * Two steps on purpose: choose who you are, then enter your PIN. Identifying
 * the account first means a PIN can only ever open the person it belongs to,
 * rather than matching whoever happens to share those four digits — which is
 * what keeps the audit trail meaningful.
 */
export function PinPad({ accounts }: { accounts: PinAccount[] }) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<PinAccount | null>(accounts.length === 1 ? accounts[0] : null);
  const [digits, setDigits] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const submit = React.useCallback(
    (pin: string, account: PinAccount) => {
      startTransition(async () => {
        const result = await pinLoginAction(account.id, pin);
        if (result?.ok) {
          router.push(result.data.redirectTo);
          router.refresh();
        } else {
          setError(result?.error ?? 'That PIN is not correct.');
          setDigits('');
        }
      });
    },
    [router],
  );

  function press(digit: string) {
    if (pending || !selected || digits.length >= 4) return;
    setError(null);
    const next = digits + digit;
    setDigits(next);
    if (next.length === 4) submit(next, selected);
  }

  function backspace() {
    if (pending) return;
    setError(null);
    setDigits((current) => current.slice(0, -1));
  }

  // A physical keyboard should work as well as the on-screen pad.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!selected) return;
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') backspace();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!selected) {
    return (
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <h2 className="text-xl font-semibold tracking-tight text-ink">Who is signing in?</h2>
          <p className="text-sm text-ink-muted">Choose your name, then enter your PIN.</p>
        </div>

        <ul className="space-y-2">
          {accounts.map((account) => (
            <li key={account.id}>
              <button
                type="button"
                onClick={() => setSelected(account)}
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left shadow-card transition-colors hover:border-forest-300 hover:bg-forest-50/50"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-forest-800 text-sm font-semibold text-white">
                  {initials(account.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{account.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{account.role}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-ink-subtle">
                  {account.companies.map((company) => (
                    <span key={company.code} className="block whitespace-nowrap">
                      {flagFor(company.country)} {company.code}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="text-center text-xs text-ink-subtle">
          <Link href="/login/password" className="font-medium text-forest-700 hover:underline">
            Sign in with a password instead
          </Link>
        </p>
      </div>
    );
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-3 text-center">
        {accounts.length > 1 ? (
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setDigits('');
              setError(null);
            }}
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink"
          >
            <ChevronLeft className="size-3.5" />
            Not you?
          </button>
        ) : null}

        <div>
          <p className="text-lg font-semibold text-ink">{selected.name}</p>
          <p className="text-xs text-ink-muted">
            {selected.role} ·{' '}
            {selected.companies.map((company) => `${flagFor(company.country)} ${company.name}`).join(' · ')}
          </p>
        </div>
      </div>

      {/* Four dots, filled as the PIN is entered. */}
      <div
        className="flex justify-center gap-4"
        role="status"
        aria-live="polite"
        aria-label={`${digits.length} of 4 digits entered`}
      >
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={cn(
              'size-4 rounded-full border-2 transition-colors',
              index < digits.length ? 'border-forest-800 bg-forest-800' : 'border-line-strong bg-transparent',
              error && 'border-red-400',
            )}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-center text-xs font-medium text-red-600">
          {error}
        </p>
      ) : (
        <p className="text-center text-xs text-ink-subtle">Enter your four-digit PIN</p>
      )}

      <div className="grid grid-cols-3 gap-3">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            disabled={pending}
            aria-label={key}
            className="tnum h-16 rounded-xl border border-line bg-surface text-xl font-medium text-ink shadow-card transition-colors hover:border-forest-300 hover:bg-forest-50 active:bg-forest-100 disabled:opacity-50"
          >
            {key}
          </button>
        ))}
        <span />
        <button
          type="button"
          onClick={() => press('0')}
          disabled={pending}
          aria-label="0"
          className="tnum h-16 rounded-xl border border-line bg-surface text-xl font-medium text-ink shadow-card transition-colors hover:border-forest-300 hover:bg-forest-50 active:bg-forest-100 disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={pending || digits.length === 0}
          aria-label="Delete the last digit"
          className="grid h-16 place-items-center rounded-xl border border-line bg-surface text-ink-muted shadow-card transition-colors hover:border-forest-300 hover:bg-forest-50 disabled:opacity-40"
        >
          <Delete className="size-5" />
        </button>
      </div>

      <p className="text-center text-xs text-ink-subtle">
        <Link
          href="/login/password"
          className="inline-flex items-center gap-1 font-medium text-forest-700 hover:underline"
        >
          <KeyRound className="size-3.5" />
          Forgotten your PIN? Use a password
        </Link>
      </p>
    </div>
  );
}
