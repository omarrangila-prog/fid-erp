'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { correctPurchaseContractAction } from '@/server/actions/trading-actions';

export function CorrectOrderForm({ id, reference, canCreate }: { id: string; reference: string; canCreate: boolean }) {
  const router = useRouter();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    const result = await correctPurchaseContractAction(id, reason);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success('The approved order was reversed. Put the copy right, then save it.');
    router.push(`/purchases/${result.data.draftId}/edit`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What correcting does</CardTitle>
        <CardDescription>
          The approved order is reversed — the supplier payable and the in-transit stock it created are taken back
          out, with a reversal entry dated today that stays in the books — and a draft copy of {reference} opens with
          every container, ready to be put right. Saving the copy approves it again under the same reference.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Callout tone="info">
          Use this when the order itself was entered wrongly — a missing container, a wrong quantity or price. To
          divide a row into containers without changing anything else, use <strong>Add a container</strong> on the
          order instead; that does not touch the books.
        </Callout>
        <Field label="Reason" htmlFor="correctReason" hint="Kept on the reversal and in the audit log.">
          <Textarea
            id="correctReason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Third container was missing from the order"
          />
        </Field>
        {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.back()} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canCreate}>
            <Pencil />
            Reverse and open a copy to edit
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
