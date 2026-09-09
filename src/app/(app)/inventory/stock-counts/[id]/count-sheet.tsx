'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Save, CheckCircle2, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, QuantityInput, Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { dec, toMoney, sum, Decimal } from '@/lib/money';
import { formatQuantityKg, formatMoney } from '@/lib/format';
import { recordStockCountAction, postStockCountAction } from '@/server/actions/compliance-actions';

export type CountLine = {
  batchId: string;
  batchNumber: string;
  itemName: string;
  lotNumber: string;
  systemKg: string;
  countedKg: string | null;
  reason: string | null;
  notes: string | null;
  landedUnitCostUsd: string;
};

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'COUNT_ADJUSTMENT', label: 'Count correction — the books were wrong' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LOSS', label: 'Loss or theft' },
  { value: 'CORRECTION', label: 'Data-entry correction' },
  { value: 'OTHER', label: 'Other — explain in the note' },
];

/**
 * The count sheet.
 *
 * Built for someone standing in a warehouse with a phone: the system quantity
 * is shown but never pre-filled into the input, because a pre-filled figure is
 * one the counter agrees with by default, which defeats the purpose of counting.
 */
export function CountSheet({
  id,
  countNumber,
  status,
  lines: initialLines,
  canManage,
  canPost,
}: {
  id: string;
  countNumber: string;
  status: string;
  lines: CountLine[];
  canManage: boolean;
  canPost: boolean;
}) {
  const router = useRouter();
  const [lines, setLines] = React.useState(initialLines);
  const [saving, setSaving] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [confirmPost, setConfirmPost] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const readOnly = status === 'POSTED' || status === 'CANCELLED' || !canManage;

  function setLine(batchId: string, patch: Partial<CountLine>) {
    setLines((current) => current.map((line) => (line.batchId === batchId ? { ...line, ...patch } : line)));
  }

  const rows = lines.map((line) => {
    const counted = line.countedKg === null || line.countedKg === '' ? null : dec(line.countedKg);
    const difference = counted ? counted.minus(line.systemKg) : null;
    const valueUsd = difference ? toMoney(difference.times(line.landedUnitCostUsd)) : null;
    return { line, counted, difference, valueUsd, needsReason: Boolean(difference && !difference.isZero() && !line.reason) };
  });

  const countedRows = rows.filter((row) => row.counted !== null);
  const differenceRows = rows.filter((row) => row.difference && !row.difference.isZero());
  const missingReasons = rows.filter((row) => row.needsReason);
  const netValueUsd = toMoney(sum(differenceRows.map((row) => row.valueUsd ?? new Decimal(0))));

  async function save() {
    setError(null);
    if (countedRows.length === 0) {
      setError('Enter at least one counted quantity before saving.');
      return;
    }
    if (missingReasons.length > 0) {
      setError(
        `${missingReasons.length} line${missingReasons.length === 1 ? '' : 's'} differ from the system without a reason. Every difference has to be explained.`,
      );
      return;
    }

    setSaving(true);
    try {
      const payload = {
        lines: countedRows.map((row) => ({
          batchId: row.line.batchId,
          countedKg: row.line.countedKg,
          reason: row.line.reason || null,
          notes: row.line.notes ?? '',
        })),
      };
      const result = await recordStockCountAction(id, JSON.stringify(payload));
      if (result?.ok) {
        toast.success('Counted quantities saved.');
        router.refresh();
      } else {
        setError(result?.error ?? 'The count could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Callout tone="danger" title="This count could not be saved">
          {error}
        </Callout>
      ) : null}

      {status === 'POSTED' ? (
        <Callout tone="info" title="Posted">
          The differences below have been written to the stock ledger and valued against inventory. To correct them
          now, raise a new count.
        </Callout>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Count sheet</CardTitle>
            <CardDescription>
              {countedRows.length} of {lines.length} counted · {differenceRows.length} difference
              {differenceRows.length === 1 ? '' : 's'}
              {differenceRows.length > 0 ? ` worth ${formatMoney(netValueUsd, 'USD')} net` : ''}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer />
              Print blank sheet
            </Button>
            {!readOnly ? (
              <Button size="sm" loading={saving} onClick={save}>
                <Save />
                Save
              </Button>
            ) : null}
            {canPost && status === 'COUNTED' ? (
              <Button size="sm" variant="accent" loading={posting} onClick={() => setConfirmPost(true)}>
                <CheckCircle2 />
                Post adjustments
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Batch</TH>
                  <TH numeric>System</TH>
                  <TH numeric>Counted</TH>
                  <TH numeric>Difference</TH>
                  <TH>Reason</TH>
                  <TH>Note</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map(({ line, difference, valueUsd, needsReason }) => (
                  <TR key={line.batchId}>
                    <TD>
                      <span className="block font-medium">{line.batchNumber}</span>
                      <span className="block text-xs text-ink-subtle">
                        {line.itemName} · Lot {line.lotNumber}
                      </span>
                    </TD>
                    <TD numeric>{formatQuantityKg(line.systemKg)}</TD>
                    <TD numeric className="w-32">
                      {readOnly ? (
                        line.countedKg === null ? (
                          <span className="text-ink-subtle">—</span>
                        ) : (
                          formatQuantityKg(line.countedKg)
                        )
                      ) : (
                        <QuantityInput
                          value={line.countedKg ?? ''}
                          onChange={(event) => setLine(line.batchId, { countedKg: event.target.value })}
                          aria-label={`Counted quantity for batch ${line.batchNumber}`}
                          placeholder="—"
                        />
                      )}
                    </TD>
                    <TD numeric>
                      {difference === null ? (
                        <span className="text-ink-subtle">—</span>
                      ) : difference.isZero() ? (
                        <span className="text-ink-subtle">Agrees</span>
                      ) : (
                        <span className={difference.greaterThan(0) ? 'text-emerald-700' : 'text-red-600'}>
                          <span className="block tabular-nums">
                            {difference.greaterThan(0) ? '+' : ''}
                            {formatQuantityKg(difference)}
                          </span>
                          {valueUsd ? (
                            <span className="block text-xs">{formatMoney(valueUsd, 'USD')}</span>
                          ) : null}
                        </span>
                      )}
                    </TD>
                    <TD className="w-56">
                      {difference && !difference.isZero() ? (
                        readOnly ? (
                          <span className="text-xs">{line.reason ?? '—'}</span>
                        ) : (
                          <Select
                            value={line.reason ?? ''}
                            onChange={(event) => setLine(line.batchId, { reason: event.target.value })}
                            aria-invalid={needsReason}
                            aria-label={`Reason for the difference on batch ${line.batchNumber}`}
                          >
                            <option value="">Choose a reason…</option>
                            {REASONS.map((reason) => (
                              <option key={reason.value} value={reason.value}>
                                {reason.label}
                              </option>
                            ))}
                          </Select>
                        )
                      ) : (
                        <span className="text-xs text-ink-subtle">—</span>
                      )}
                    </TD>
                    <TD className="w-48">
                      {readOnly ? (
                        <span className="text-xs">{line.notes ?? '—'}</span>
                      ) : (
                        <Input
                          value={line.notes ?? ''}
                          onChange={(event) => setLine(line.batchId, { notes: event.target.value })}
                          aria-label={`Note for batch ${line.batchNumber}`}
                          maxLength={300}
                        />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmPost}
        onOpenChange={setConfirmPost}
        title={`Post ${countNumber}?`}
        description={`${differenceRows.length} difference${differenceRows.length === 1 ? '' : 's'} will be written to the stock ledger and valued at ${formatMoney(netValueUsd, 'USD')} net against Inventory Adjustments. This cannot be undone — a mistake is corrected with a further count.`}
        confirmLabel="Post adjustments"
        onConfirm={async () => {
          setPosting(true);
          try {
            const result = await postStockCountAction(id);
            if (result.ok) {
              toast.success('Count posted and stock adjusted.');
              router.refresh();
            } else {
              throw new Error(result.error);
            }
          } finally {
            setPosting(false);
          }
        }}
      />
    </div>
  );
}
