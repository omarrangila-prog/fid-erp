'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Landmark, CheckCircle2, XCircle, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { changeChequeStatusAction } from '@/server/actions/finance-actions';

type Target = 'DEPOSITED' | 'CLEARED' | 'BOUNCED' | 'CANCELLED';

const ACTIONS: Record<Target, { label: string; icon: typeof Landmark; variant: 'primary' | 'accent' | 'danger' | 'outline'; blurb: string }> = {
  DEPOSITED: {
    label: 'Mark deposited',
    icon: Landmark,
    variant: 'outline',
    blurb: 'The cheque has gone to the bank. No accounting entry is made — the money has not moved yet.',
  },
  CLEARED: {
    label: 'Mark cleared',
    icon: CheckCircle2,
    variant: 'accent',
    blurb: 'The funds have settled. This moves the value into the bank account you choose.',
  },
  BOUNCED: {
    label: 'Mark bounced',
    icon: XCircle,
    variant: 'danger',
    blurb: 'The cheque was returned unpaid. The debt is reinstated in full.',
  },
  CANCELLED: {
    label: 'Cancel cheque',
    icon: Ban,
    variant: 'outline',
    blurb: 'The cheque was withdrawn or replaced. The debt is reinstated.',
  },
};

const ALLOWED: Record<string, Target[]> = {
  RECEIVED: ['DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'],
  DEPOSITED: ['CLEARED', 'BOUNCED', 'CANCELLED'],
  BOUNCED: ['DEPOSITED'],
  CLEARED: [],
  CANCELLED: [],
};

export function ChequeStatusActions({
  chequeId,
  status,
  currency,
  bankAccounts,
}: {
  chequeId: string;
  status: string;
  currency: string;
  bankAccounts: Array<{ id: string; name: string; currency: string }>;
}) {
  const router = useRouter();
  const [target, setTarget] = React.useState<Target | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [accountId, setAccountId] = React.useState(bankAccounts[0]?.id ?? '');
  const [effectiveDate, setEffectiveDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const available = ALLOWED[status] ?? [];

  function submit() {
    if (!target) return;
    setError(null);

    startTransition(async () => {
      const result = await changeChequeStatusAction(
        chequeId,
        JSON.stringify({
          toStatus: target,
          cashBankAccountId: target === 'CLEARED' ? accountId : undefined,
          effectiveDate,
          reason: reason || undefined,
        }),
      );

      if (!result?.ok) {
        setError(result?.error ?? 'The cheque could not be updated.');
        return;
      }

      toast.success(result.message);
      setTarget(null);
      setReason('');
      router.refresh();
    });
  }

  if (available.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            This cheque is {status.toLowerCase()} and has reached the end of its life cycle.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Update status</CardTitle>
          <CardDescription>Each change posts the matching accounting entry.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {available.map((value) => {
            const meta = ACTIONS[value];
            const Icon = meta.icon;
            return (
              <Button
                key={value}
                variant={meta.variant}
                className="w-full justify-start"
                onClick={() => {
                  setTarget(value);
                  setError(null);
                }}
              >
                <Icon />
                {meta.label}
              </Button>
            );
          })}
        </CardContent>
      </Card>

      {target ? (
        <Dialog open onOpenChange={(open) => !open && setTarget(null)}>
          <DialogContent title={ACTIONS[target].label} description={ACTIONS[target].blurb}>
            <div className="space-y-4">
              {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}

              <Field label="Effective date" htmlFor="effectiveDate" required>
                <Input
                  id="effectiveDate"
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                />
              </Field>

              {target === 'CLEARED' ? (
                <Field
                  label="Bank account"
                  htmlFor="accountId"
                  required
                  hint={`Must be a ${currency} account.`}
                >
                  <Select id="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {bankAccounts.length === 0 ? <option value="">No matching bank account</option> : null}
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}

              {target === 'BOUNCED' || target === 'CANCELLED' ? (
                <Field label="Reason" htmlFor="reason" required={target === 'BOUNCED'}>
                  <Textarea
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Insufficient funds"
                  />
                </Field>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setTarget(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant={ACTIONS[target].variant === 'outline' ? 'primary' : ACTIONS[target].variant}
                onClick={submit}
                loading={pending}
                disabled={target === 'CLEARED' && !accountId}
              >
                {ACTIONS[target].label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
