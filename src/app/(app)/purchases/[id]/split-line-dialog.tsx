'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Pencil, Scissors, SplitSquareHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { splitContractLineAction } from '@/server/actions/trading-actions';

export type SplittableLine = {
  id: string;
  lineNumber: number;
  itemName: string;
  quantityKg: string;
  containerNumber: string | null;
  /** Nothing received, sold or reserved yet, so the line can still be divided. */
  splittable: boolean;
};

/**
 * "This row is really three containers."
 *
 * The client enters 40,080 KG as one row and it sails in two containers; an
 * approved order cannot be edited, but the containers still need their own
 * rows so each can arrive and be received on its own. This divides a row
 * into containers on the spot — the kilograms split evenly and editable,
 * the container numbers optional — and the books do not move.
 */
export function SplitLineDialog({
  contractId,
  contractReference,
  lines,
  canSplit,
  canCorrect,
}: {
  contractId: string;
  contractReference: string;
  lines: SplittableLine[];
  canSplit: boolean;
  canCorrect: boolean;
}) {
  const router = useRouter();
  const [line, setLine] = React.useState<SplittableLine | null>(null);
  const [count, setCount] = React.useState('2');
  const [parts, setParts] = React.useState<Array<{ quantityKg: string; containerNumber: string }>>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const splittable = lines.filter((l) => l.splittable);

  function openFor(target: SplittableLine, n = 2) {
    setLine(target);
    setCount(String(n));
    setParts(evenParts(target, n));
    setError(null);
  }

  function evenParts(target: SplittableLine, n: number) {
    const total = Number(target.quantityKg) || 0;
    const each = Math.floor((total / n) * 1000) / 1000;
    return Array.from({ length: n }, (_, i) => ({
      quantityKg: String(i === n - 1 ? Math.round((total - each * (n - 1)) * 1000) / 1000 : each),
      containerNumber: i === 0 ? (target.containerNumber ?? '') : '',
    }));
  }

  function changeCount(value: string) {
    setCount(value);
    const n = Number(value);
    if (line && Number.isInteger(n) && n >= 2 && n <= 40) setParts(evenParts(line, n));
  }

  const entered = parts.reduce((sum, p) => sum + (Number(p.quantityKg) || 0), 0);
  const expected = Number(line?.quantityKg ?? 0);
  const balanced = Math.abs(entered - expected) < 0.0005;

  async function submit() {
    if (!line) return;
    setError(null);
    if (!balanced) {
      setError(`The containers add up to ${entered.toLocaleString()} KG; the row is ${expected.toLocaleString()} KG.`);
      return;
    }
    setBusy(true);
    const result = await splitContractLineAction(
      JSON.stringify({
        purchaseContractId: contractId,
        lineId: line.id,
        parts: parts.map((p) => ({ quantityKg: p.quantityKg.trim(), containerNumber: p.containerNumber.trim() || undefined })),
      }),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(`Row ${line.lineNumber} is now ${result.data.containers} containers.`);
    setLine(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canSplit && splittable.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => openFor(splittable[0])}>
            <SplitSquareHorizontal />
            Add a container
          </Button>
        ) : null}
        {canCorrect ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/purchases/${contractId}/correct`}>
              <Pencil />
              Edit this order
            </Link>
          </Button>
        ) : null}
      </div>

      {canSplit
        ? splittable.map((l) => (
            <button
              key={l.id}
              type="button"
              data-split-line={l.id}
              className="hidden"
              onClick={() => openFor(l)}
              aria-hidden
            />
          ))
        : null}

      <Dialog open={line !== null} onOpenChange={(open) => !open && setLine(null)}>
        <DialogContent
          title={line ? `Divide row ${line.lineNumber} into containers` : ''}
          description={
            line
              ? `${line.itemName}, ${Number(line.quantityKg).toLocaleString()} KG on ${contractReference}. Each container gets its own row, lot and batch; the order's value does not change.`
              : undefined
          }
        >
          <div className="space-y-4">
            {splittable.length > 1 && line ? (
              <Field label="Row to divide" htmlFor="splitLine">
                <select
                  id="splitLine"
                  className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm"
                  value={line.id}
                  onChange={(e) => {
                    const next = splittable.find((l) => l.id === e.target.value);
                    if (next) openFor(next, Number(count) || 2);
                  }}
                >
                  {splittable.map((l) => (
                    <option key={l.id} value={l.id}>
                      Row {l.lineNumber} · {l.itemName} · {Number(l.quantityKg).toLocaleString()} KG
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field label="Number of containers" htmlFor="splitCount" required>
              <Input
                id="splitCount"
                inputMode="numeric"
                className="tnum w-24 text-right"
                value={count}
                onChange={(e) => changeCount(e.target.value)}
              />
            </Field>

            <div className="space-y-2">
              {parts.map((part, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-2">
                  <Field label={`Container ${index + 1} — KG`} htmlFor={`part-kg-${index}`} required>
                    <Input
                      id={`part-kg-${index}`}
                      inputMode="decimal"
                      className="tnum text-right"
                      value={part.quantityKg}
                      onChange={(e) =>
                        setParts((prev) => prev.map((p, i) => (i === index ? { ...p, quantityKg: e.target.value } : p)))
                      }
                    />
                  </Field>
                  <Field label="Container number" htmlFor={`part-ctr-${index}`} hint={index === 0 ? undefined : 'If known.'}>
                    <Input
                      id={`part-ctr-${index}`}
                      className="font-mono"
                      placeholder="MSCU1234567"
                      value={part.containerNumber}
                      onChange={(e) =>
                        setParts((prev) => prev.map((p, i) => (i === index ? { ...p, containerNumber: e.target.value } : p)))
                      }
                    />
                  </Field>
                </div>
              ))}
            </div>

            <p className={`tnum text-xs ${balanced ? 'text-ink-muted' : 'font-medium text-red-700'}`}>
              {entered.toLocaleString()} KG of {expected.toLocaleString()} KG
              {balanced ? ' — adds up.' : ' — the containers must add up to the row.'}
            </p>

            {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}

            <Callout tone="info">
              Nothing is posted. The supplier is still owed the same amount for the same coffee; it is now tracked
              container by container.
            </Callout>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setLine(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} disabled={!balanced}>
              <Scissors />
              Divide into {parts.length} containers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A per-row "Divide" control that opens the shared dialog for that row. */
export function SplitRowButton({ lineId }: { lineId: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => (document.querySelector(`[data-split-line="${lineId}"]`) as HTMLButtonElement | null)?.click()}
    >
      <Scissors />
      Divide
    </Button>
  );
}
