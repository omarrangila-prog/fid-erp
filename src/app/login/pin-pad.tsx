'use client';

import * as React from 'react';
import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pinLoginAction } from '@/server/actions/session-actions';

/**
 * The sign-in screen: one PIN, nothing else.
 *
 * No name to pick, no email, no password — the PIN says who you are, and the
 * server works out the rest. Four digits sign in by themselves; Login does the
 * same for anyone who prefers to press it. A wrong PIN says "Incorrect PIN"
 * and nothing more.
 */
export function PinPad() {
  const [digits, setDigits] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const submit = React.useCallback((pin: string) => {
    startTransition(async () => {
      const result = await pinLoginAction(pin);
      if (result?.ok) {
        // A full load, so the new person's session starts from nothing cached.
        window.location.replace(result.data.redirectTo);
      } else {
        setError(result?.error ?? 'Incorrect PIN');
        setDigits('');
      }
    });
  }, []);

  function press(digit: string) {
    if (pending || digits.length >= 4) return;
    setError(null);
    const next = digits + digit;
    setDigits(next);
    if (next.length === 4) submit(next);
  }

  function backspace() {
    if (pending) return;
    setError(null);
    setDigits((current) => current.slice(0, -1));
  }

  // A physical keyboard works as well as the on-screen pad.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return;
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') backspace();
      else if (event.key === 'Enter' && digits.length === 4) submit(digits);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep the pad responsive without wrapping each key handler
  }, [digits, pending]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const keyClass =
    'tnum h-16 rounded-xl border border-line bg-surface text-xl font-medium text-ink shadow-card transition-colors hover:border-forest-300 hover:bg-forest-50 active:bg-forest-100 disabled:opacity-50';

  return (
    <div className="w-full max-w-sm space-y-6" data-testid="pin-login">
      <div className="space-y-1 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest-700">FID Trading</p>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Enter your PIN</h1>
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
        <p role="alert" className="text-center text-sm font-medium text-red-600" data-testid="pin-error">
          {error}
        </p>
      ) : (
        <p className="text-center text-xs text-ink-subtle">{pending ? 'Signing in…' : 'Four digits'}</p>
      )}

      <div className="grid grid-cols-3 gap-3">
        {keys.map((key) => (
          <button key={key} type="button" onClick={() => press(key)} disabled={pending} aria-label={key} className={keyClass}>
            {key}
          </button>
        ))}
        <span />
        <button type="button" onClick={() => press('0')} disabled={pending} aria-label="0" className={keyClass}>
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

      <button
        type="button"
        onClick={() => submit(digits)}
        disabled={pending || digits.length !== 4}
        className="h-12 w-full rounded-xl bg-forest-800 text-sm font-semibold text-white transition-colors hover:bg-forest-900 disabled:opacity-40"
      >
        Login
      </button>
    </div>
  );
}
