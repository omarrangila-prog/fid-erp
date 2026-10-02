'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { getShipmentDeletePreviewAction, deleteShipmentAction } from '@/server/actions/shipment-delete-actions';
import type { DeletePreview, DeleteMode } from '@/lib/services/shipment-delete';
import { safely } from '@/lib/safely';

const REASONS = ['Mistaken entry', 'Duplicate shipment', 'Wrong purchase order', 'Test entry', 'Other'] as const;

/**
 * Delete Shipment — the one window every screen opens.
 *
 * It says what the shipment is tied to, whether it can go, and what deleting
 * will undo along the way; the user picks a reason and presses one button.
 * Reversing the goods receipt, moving coffee back, cancelling unpaid costs
 * and the order itself all happen behind that button, in one transaction.
 * When something real stands in the way — a sale, a payment — it says what,
 * with a link, and the button stays off.
 */
export function DeleteShipmentDialog({
  open,
  onOpenChange,
  contractId,
  label,
  defaultMode = 'keep-order',
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  label: string;
  defaultMode?: DeleteMode;
  onDeleted?: (result: { draftId: string | null }) => void;
}) {
  if (!open) return null;
  return <Body onOpenChange={onOpenChange} contractId={contractId} label={label} defaultMode={defaultMode} onDeleted={onDeleted} />;
}

function Body({
  onOpenChange,
  contractId,
  label,
  defaultMode,
  onDeleted,
}: {
  onOpenChange: (open: boolean) => void;
  contractId: string;
  label: string;
  defaultMode: DeleteMode;
  onDeleted?: (result: { draftId: string | null }) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = React.useState<DeletePreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState<string>('');
  const [memo, setMemo] = React.useState('');
  const [mode, setMode] = React.useState<DeleteMode>(defaultMode);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    safely(getShipmentDeletePreviewAction(contractId)).then((result) => {
      if (!live) return;
      if (result.ok) setPreview(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [contractId]);

  async function confirm() {
    if (!reason) {
      setError('Choose why this shipment is being deleted.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await safely(deleteShipmentAction(JSON.stringify({ contractId, mode, reason, memo: memo.trim() || undefined })));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(mode === 'keep-order' ? `Shipment ${label} deleted. Its purchase order is kept as a draft.` : `Shipment ${label} and its purchase order deleted.`);
    onOpenChange(false);
    onDeleted?.({ draftId: result.data.draftId });
    router.refresh();
  }

  const counts: Array<[string, number | string, string?]> = preview
    ? [
        ['Containers', preview.containerCount],
        ['Goods receipts', preview.receipts.filter((r) => r.status === 'POSTED').length, preview.receipts.length ? `${Number(preview.receivedKg).toLocaleString('en-US')} KG received` : undefined],
        ['Stock movements', preview.stockMovements],
        ['Shipment costs', preview.costs.length],
        ['Warehouse transfers', preview.transfers.length],
        ['Sales invoices', preview.sales.length],
        ['Supplier payments', preview.supplierPayments.length],
      ]
    : [];

  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent title={`Delete shipment ${label}?`} description={preview ? `${preview.supplier} · ${preview.containerCount} container${preview.containerCount === 1 ? '' : 's'}${preview.containers.length ? ` (${preview.containers.join(', ')})` : ''}` : 'Checking what this shipment is tied to…'} className="sm:w-[min(44rem,94vw)]">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="delete-shipment">
          {!preview && !error ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" /> Checking what this shipment is tied to…
            </p>
          ) : null}

          {preview ? (
            <>
              <table className="data-grid grid-framed w-full text-sm" data-testid="delete-related">
                <tbody>
                  {counts.map(([name, count, note]) => (
                    <tr key={name} data-related={name}>
                      <td className="px-3 py-1.5">{name}</td>
                      <td className="tnum px-3 py-1.5 text-right font-medium">{count}</td>
                      <td className="px-3 py-1.5 text-xs text-ink-subtle">{note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {preview.canDelete ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900" data-testid="delete-safe">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <CheckCircle2 className="size-4" /> Safe to delete
                  </p>
                  {preview.willUndo.length > 0 ? (
                    <>
                      <p className="mt-1 text-xs">This will also undo, automatically:</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                        {preview.willUndo.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1 text-xs">Nothing has been received, costed or sold against it.</p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900" data-testid="delete-blocked">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="size-4" /> This shipment cannot be deleted yet
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
                    {preview.blockers.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="delete-dependencies">
                    {preview.sales.map((s) => (
                      <Link key={s.id} href={`/sales/${s.id}`} className="font-medium underline underline-offset-2">
                        View sale {s.number} ({s.customer})
                      </Link>
                    ))}
                    {preview.supplierPayments.map((p) => (
                      <Link key={p.id} href={`/finance/payments/${p.id}`} className="font-medium underline underline-offset-2">
                        View payment {p.number}
                      </Link>
                    ))}
                    {preview.costs
                      .filter((c) => c.settlement === 'PAID' || c.settlement === 'PARTIAL')
                      .map((c) => (
                        <Link key={c.id} href={`/finance/expenses/${c.id}`} className="font-medium underline underline-offset-2">
                          View cost {c.number}
                        </Link>
                      ))}
                    {preview.transfers
                      .filter((t) => t.action === 'block')
                      .map((t) => (
                        <Link key={t.id} href={`/inventory/transfers/${t.id}`} className="font-medium underline underline-offset-2">
                          View transfer {t.number}
                        </Link>
                      ))}
                    {preview.stockCounts.map((c) => (
                      <Link key={c.id} href={`/inventory/stock-counts/${c.id}`} className="font-medium underline underline-offset-2">
                        View count {c.number}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {preview.canDelete ? (
                <>
                  <fieldset className="space-y-1.5" data-testid="delete-mode">
                    <legend className="text-xs font-medium text-ink-muted">The purchase order</legend>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="radio" name="deleteMode" className="mt-1 accent-gold-600" checked={mode === 'keep-order'} onChange={() => setMode('keep-order')} />
                      <span>
                        Keep it as a draft
                        <span className="block text-xs text-ink-subtle">Same reference and lines, ready to correct and approve again.</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="radio" name="deleteMode" className="mt-1 accent-gold-600" checked={mode === 'delete-order'} onChange={() => setMode('delete-order')} />
                      <span>
                        Delete it too
                        <span className="block text-xs text-ink-subtle">The supplier is no longer owed it.</span>
                      </span>
                    </label>
                  </fieldset>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Reason" htmlFor="deleteReason" required>
                      <Select id="deleteReason" value={reason} onChange={(e) => setReason(e.target.value)}>
                        <option value="">Choose…</option>
                        {REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Memo" htmlFor="deleteMemo">
                      <Input id="deleteMemo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
                    </Field>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} loading={busy} disabled={!preview?.canDelete || busy} data-testid="confirm-delete-shipment">
            <Trash2 />
            Delete Shipment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
