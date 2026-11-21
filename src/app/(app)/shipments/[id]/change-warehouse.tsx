'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeftRight } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogTrigger, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { changeContainerWarehouseAction } from '@/server/actions/trading-actions';

/**
 * "Change warehouse" beside a container on the shipment page. Choosing the
 * right warehouse moves what is left of the container there at once, and the
 * page shows the new location without leaving it.
 */
export function ChangeWarehouseButton({
  batchId,
  containerLabel,
  itemCount,
  currentWarehouses,
  warehouses,
}: {
  batchId: string;
  containerLabel: string;
  itemCount: number;
  currentWarehouses: string;
  warehouses: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const choices = warehouses.filter((w) => w.name !== currentWarehouses);

  const save = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await changeContainerWarehouseAction(batchId, target);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(result.data.message);
      setOpen(false);
      setTarget('');
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" className="h-7 gap-1 px-2.5 text-xs" data-testid="change-warehouse">
          <ArrowLeftRight className="size-3.5" />
          Change warehouse
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Change warehouse — ${containerLabel}`}
        description={`Now in ${currentWarehouses || '—'}${itemCount > 1 ? ` · all ${itemCount} items in this container move together` : ''}.`}
      >
        <div className="space-y-3">
          <Field label="Move to warehouse" htmlFor={`wh-${batchId}`}>
            <Select id={`wh-${batchId}`} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="change-warehouse-select">
              <option value="">Choose the right warehouse…</option>
              {choices.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-ink-subtle">
            What is left of the container is moved as a stock transfer, so the move shows on the stock movements. Coffee
            already sold stays sold; nothing is posted to the accounts.
          </p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={save} disabled={!target || pending} data-testid="change-warehouse-save">
            {pending ? 'Moving…' : 'Move container'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
