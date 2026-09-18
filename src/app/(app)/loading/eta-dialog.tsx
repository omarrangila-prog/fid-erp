'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { updateShipmentEtaAction, markShipmentArrivedAction, getShipmentEtaHistoryAction } from '@/server/actions/trading-actions';
import { formatDate, formatDateTime, todayInputValue } from '@/lib/format';

/**
 * Change an expected arrival, from the row it is on.
 *
 * A shipping line moves an ETA every two or three days. Staff walk the live
 * consignments updating fifteen or twenty at a time, and opening each shipment
 * to change one date turns five minutes of work into fifteen page loads. There
 * is no limit and no approval — the date is what somebody was told, and the
 * only interesting thing about it is what it says now. Every change is written
 * to the audit trail against the date it replaced.
 */
export function EtaDialog({
  shipmentId,
  contractLabel,
  currentEta,
  onClose,
}: {
  shipmentId: string;
  contractLabel: string;
  currentEta: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [eta, setEta] = React.useState(currentEta ?? '');
  const [history, setHistory] = React.useState<
    Array<{ changedAt: string; changedBy: string; from: string | null; to: string | null }>
  >([]);

  React.useEffect(() => {
    let cancelled = false;
    getShipmentEtaHistoryAction(shipmentId).then((result) => {
      if (!cancelled && result.ok) setHistory(result.rows);
    });
    return () => {
      cancelled = true;
    };
  }, [shipmentId]);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await updateShipmentEtaAction(shipmentId, eta);
      if (!result?.ok) {
        setError(result?.error ?? 'The ETA could not be changed.');
        return;
      }
      toast.success('ETA updated.');
      onClose();
      router.refresh();
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title="Expected arrival"
      description={`${contractLabel}. Change it as often as the line changes it.`}
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Save ETA
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="ETA" htmlFor="etaDate" hint="Leave blank if the line has withdrawn the date.">
          <Input id="etaDate" type="date" autoFocus value={eta} onChange={(e) => setEta(e.target.value)} />
        </Field>

        <Callout tone="info">
          Change it as often as the line changes it. Every previous date stays on this shipment.
        </Callout>

        {history.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Previous ETAs</p>
            <ul className="space-y-1.5">
              {history.map((row) => (
                <li key={row.changedAt} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink">
                    {formatDate(row.from)} → {formatDate(row.to)}
                  </span>
                  <span className="text-ink-subtle">
                    {row.changedBy} · {formatDateTime(row.changedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * Mark a consignment arrived.
 *
 * One date, because that is the whole event. The steps that used to sit
 * between loaded and arrived — in transit, customs clearing, cleared — were
 * stages nobody updated, and the goods receipt is what actually records the
 * coffee landing in a warehouse.
 */
export function ArrivedDialog({
  shipmentId,
  contractLabel,
  onClose,
}: {
  shipmentId: string;
  contractLabel: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [ataDate, setAtaDate] = React.useState(todayInputValue());

  function submit() {
    setError(null);
    if (!ataDate) {
      setError('Enter the date it actually arrived.');
      return;
    }

    startTransition(async () => {
      const result = await markShipmentArrivedAction(shipmentId, ataDate);
      if (!result?.ok) {
        setError(result?.error ?? 'This could not be marked arrived.');
        return;
      }
      toast.success('Marked arrived. Receive the goods when you are ready.');
      onClose();
      router.refresh();
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title="Mark as arrived"
      description={`${contractLabel} has landed.`}
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Mark as arrived
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Arrived on" htmlFor="ataDate" required>
          <Input id="ataDate" type="date" autoFocus value={ataDate} onChange={(e) => setAtaDate(e.target.value)} />
        </Field>

        <Callout tone="info">
          Arriving does not put coffee into a warehouse. A <strong>Receive</strong> button appears on this row once it
          has arrived — that is where the warehouse, the quantity and the lot are recorded, and where the stock
          actually increases.
        </Callout>
      </div>
    </Sheet>
  );
}
