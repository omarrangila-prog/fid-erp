'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { restateInventorySplitAction } from '@/server/actions/inventory-split-actions';

/** Puts the ledger's stock / cost-of-sales line back where the costing has it. */
export function RestateSplitButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await restateInventorySplitAction();
          if (result.ok) {
            toast.success(result.message ?? 'Done.');
            router.refresh();
          } else toast.error(result.error);
        })
      }
    >
      {pending ? 'Restating…' : 'Restate stock / cost of sales now'}
    </Button>
  );
}
