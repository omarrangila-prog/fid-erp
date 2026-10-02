'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DeleteShipmentDialog } from '@/components/shipments/delete-shipment-dialog';
import type { DeleteMode } from '@/lib/services/shipment-delete';

/**
 * The page's one red action: Delete Shipment. Opens the window every screen
 * shares; once the shipment is gone, the page it was on goes too — to the
 * draft order when it was kept, otherwise to the list.
 */
export function DeleteShipmentButton({
  contractId,
  label,
  defaultMode = 'keep-order',
  after = '/loading',
  children = 'Delete Shipment',
}: {
  contractId: string;
  label: string;
  defaultMode?: DeleteMode;
  /** Where to go once it is deleted and no order was kept. */
  after?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="border-red-300 text-red-700 hover:border-red-400 hover:bg-red-50 hover:text-red-800"
        onClick={() => setOpen(true)}
        data-testid="delete-shipment-button"
      >
        <Trash2 />
        {children}
      </Button>
      <DeleteShipmentDialog
        open={open}
        onOpenChange={setOpen}
        contractId={contractId}
        label={label}
        defaultMode={defaultMode}
        onDeleted={({ draftId }) => router.push(draftId ? `/purchases/${draftId}` : after)}
      />
    </>
  );
}
