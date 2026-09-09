'use client';

import * as React from 'react';
import { PurchaseActions } from '@/app/(app)/purchases/[id]/purchase-actions';
import { GoodsReceiptDialog, type ReceivableBatch } from '@/app/(app)/purchases/[id]/goods-receipt-dialog';

/** Holds the shared open/closed state between the toolbar and the receipt sheet. */
export function PurchaseDetailToolbar({
  id,
  contractNumber,
  status,
  permissions,
  fullyReceived,
  batches,
  warehouses,
  defaultWarehouseId,
}: {
  id: string;
  contractNumber: string;
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
        contractNumber={contractNumber}
        batches={batches.filter((b) => Number(b.outstandingKg) > 0)}
        warehouses={warehouses}
        defaultWarehouseId={defaultWarehouseId}
      />
    </>
  );
}
