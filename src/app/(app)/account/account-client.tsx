'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { changePasswordAction } from '@/server/actions/session-actions';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';

export function ChangePasswordCard() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(changePasswordAction, null);

  React.useEffect(() => {
    if (state?.ok) {
      toast.success('Password changed. Sign in again with your new password.');
      // Changing a password invalidates every session, including this one, so
      // send the user to the login screen.
      window.setTimeout(() => {
        router.replace('/login');
        router.refresh();
      }, 1200);
    }
  }, [state, router]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          At least 10 characters, with an upper-case letter, a lower-case letter and a digit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="max-w-md space-y-4">
          {state && !state.ok ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{state.error}</span>
            </div>
          ) : null}

          <Field label="Current password" htmlFor="currentPassword" required>
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>

          <Field label="New password" htmlFor="newPassword" required>
            <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required />
          </Field>

          <Field label="Confirm new password" htmlFor="confirmPassword" required>
            <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
          </Field>

          <Callout tone="info">
            <span className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Changing your password signs you out of every device, including this one.
            </span>
          </Callout>

          <Button type="submit" loading={pending}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
