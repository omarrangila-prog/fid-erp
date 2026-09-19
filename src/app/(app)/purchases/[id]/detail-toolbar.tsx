'use client';

import * as React from 'react';
import { PurchaseActions } from '@/app/(app)/purchases/[id]/purchase-actions';
import { GoodsReceiptDialog, type ReceivableBatch } from '@/app/(app)/purchases/[id]/goods-receipt-dialog';
import { RECEIVE_GOODS_EVENT } from '@/app/(app)/purchases/[id]/order-shipments';

/** Holds the shared open/closed state between the toolbar and the receipt sheet. */
export function PurchaseDetailToolbar({
  id,
  contractLabel,
  status,
  permissions,
  fullyReceived,
  batches,
  warehouses,
  defaultWarehouseId,
}: {
  id: string;
  contractLabel: string;
  status: string;
  permissions: {
    approve: boolean;
    edit: boolean;
    delete: boolean;
    reverse: boolean;
    receive: boolean;
  };
  fullyReceived: boolean;
  batches: ReceivableBatch[];
  warehouses: Array<{ id: string; name: string; code: string }>;
  defaultWarehouseId: string | null;
}) {
  const [receiving, setReceiving] = React.useState(false);

  // A row on the containers table can open the same sheet, so "Receive
  // goods" is beside the container and not only at the top of the page.
  React.useEffect(() => {
    if (!permissions.receive) return;
    const open = () => setReceiving(true);
    window.addEventListener(RECEIVE_GOODS_EVENT, open);
    return () => window.removeEventListener(RECEIVE_GOODS_EVENT, open);
  }, [permissions.receive]);

  return (
    <>
      <PurchaseActions
        id={id}
        status={status}
        canApprove={permissions.approve}
        canEdit={permissions.edit}
        canDelete={permissions.delete}
        canReverse={permissions.reverse}
        canReceive={permissions.receive && warehouses.length > 0}
        fullyReceived={fullyReceived}
        onReceive={() => setReceiving(true)}
      />

      <GoodsReceiptDialog
        open={receiving}
        onOpenChange={setReceiving}
        purchaseContractId={id}
        contractLabel={contractLabel}
        batches={batches.filter((b) => Number(b.outstandingKg) > 0)}
        warehouses={warehouses}
        defaultWarehouseId={defaultWarehouseId}
      />
    </>
  );
}
