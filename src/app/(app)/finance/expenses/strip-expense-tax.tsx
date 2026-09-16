'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { stripUnselectedExpenseTaxAction } from '@/server/actions/finance-actions';

export function StripExpenseTaxButton({
  id,
  originalAmount,
  currency,
  grossAmount,
}: {
  id: string;
  originalAmount: string;
  currency: string;
  grossAmount: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Restate cash to {currency} {originalAmount}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove unselected 20% tax"
        description={`Cash currently moved ${currency} ${grossAmount} because a default 20% TVA was applied. The amount entered was ${currency} ${originalAmount}. This rewrites the original cash and VAT journal lines — it does not post a reversal, and landed cost stays at the net amount.`}
        confirmLabel="Restate cash"
        variant="danger"
        requireReason
        reasonLabel="Why is this tax being removed?"
        onConfirm={async (reason) => {
          const result = await stripUnselectedExpenseTaxAction(id, reason);
          if (!result.ok) {
            throw new Error(result.error);
          }
          toast.success(`Cash restated to ${currency} ${originalAmount}.`);
          router.refresh();
        }}
      />
    </>
  );
}
