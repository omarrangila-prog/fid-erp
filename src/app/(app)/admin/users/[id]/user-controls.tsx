'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/shared/form-error';
import { setUserActiveAction, setUserPinAction } from '@/server/actions/admin-actions';

/** New PIN, typed twice. The old one is never shown. */
export function UserPinForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [pin, setPin] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 4);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await setUserPinAction(userId, pin, confirm);
          if (result.ok) {
            toast.success('PIN changed. The old PIN no longer works.');
            setPin('');
            setConfirm('');
            router.refresh();
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="New PIN" htmlFor="newPin">
          <Input id="newPin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <Field label="Confirm PIN" htmlFor="confirmNewPin">
          <Input id="confirmNewPin" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} />
        </Field>
      </div>
      <FormError message={error} />
      <Button type="submit" loading={pending} disabled={pin.length !== 4 || confirm.length !== 4} data-testid="save-pin">
        Save new PIN
      </Button>
    </form>
  );
}

export function UserStatusButton({ userId, active }: { userId: string; active: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      variant={active ? 'outline' : 'primary'}
      loading={pending}
      data-testid="toggle-user-status"
      onClick={() =>
        startTransition(async () => {
          const result = await setUserActiveAction(userId, !active);
          if (result.ok) {
            toast.success(active ? 'Disabled — signed out everywhere.' : 'Enabled — the PIN works again.');
            router.refresh();
          } else {
            toast.error(result.error);
          }
        })
      }
    >
      {active ? 'Disable user' : 'Enable user'}
    </Button>
  );
}
