'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Anchor, Boxes, CalendarClock, Eye, FileText, History, PackageCheck, Pencil, Ship, Trash2, Loader2 } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { DOCUMENT_STATUS_META, DOCUMENT_STATUS_HINT, DOCUMENT_STATUS_CHOICES, documentStatusOptions } from '@/lib/constants';
import { CONTAINER_STAGE_META, containerStage, type ContainerStage } from '@/lib/container-stage';
import { summariseContainers, ARRIVAL_STATE_META, RECEIPT_STATE_META, documentLabel } from '@/lib/container-summary';
import { receivableBatches } from '@/lib/receivable-batches';
import { formatDate, formatDateTime, formatQuantityKg, todayInputValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  getQuickUpdateAction,
  quickUpdateContainersAction,
  getContainerHistoryAction,
} from '@/server/actions/quick-update-actions';
import type { QuickOrder, QuickContainer, ContainerHistoryRow } from '@/server/actions/quick-update-actions';
import { undoLoadingAction, undoArrivalAction, removeContainerAction } from '@/server/actions/trading-actions';
import { DeleteShipmentDialog } from '@/components/shipments/delete-shipment-dialog';
import { MarkLoadedDialog } from '@/app/(app)/loading/mark-loaded-dialog';
import { DocumentStatusDialog, composeDocumentNote } from '@/app/(app)/loading/document-status-dialog';
import { ManageContainersDialog } from '@/app/(app)/loading/manage-containers-dialog';
import { GoodsReceiptDialog } from '@/app/(app)/purchases/[id]/goods-receipt-dialog';
import { EditContainerDialog, type EditableContainer } from '@/components/shipments/edit-container-dialog';
import { safely } from '@/lib/safely';

/** What the row's button asked for, so the panel opens ready to do it. */
export type QuickIntent = 'load' | 'eta' | 'documents' | 'arrive' | 'receive' | null;

type Bulk = 'load' | 'eta' | 'documents' | 'arrive' | null;

const WORKING_WITH = ['Supplier', 'Shipping line', 'Clearing agent', 'Bank', 'Customer', 'FID office'];

const fully = (c: QuickContainer) => Number(c.receivedKg) > 0 && Number(c.receivedKg) >= Number(c.orderedKg) - 0.001;
const stageOf = (c: QuickContainer): ContainerStage => containerStage(c.status, fully(c));
const isLoaded = (c: QuickContainer) => stageOf(c) !== 'PENDING_LOADING';
const isArrived = (c: QuickContainer) => stageOf(c) === 'ARRIVED' || stageOf(c) === 'RECEIVED';
const nameOf = (c: QuickContainer) => (c.containerNumbers.length > 0 ? c.containerNumbers.join(', ') : `Shipment ${c.ordinal}`);
/** Enough is known to mark it loaded with one click: the date it lands, who carries it, and what identifies it. */
const readyToLoad = (c: QuickContainer) =>
  Boolean(c.etaIso && c.shippingLineId && (c.containerNumbers.length > 0 || c.bookingNumber || c.billOfLading));

function useWide() {
  return React.useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(min-width: 768px)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(min-width: 768px)').matches,
    () => true,
  );
}

/**
 * Quick Update — the order's containers, and what is done to them every day,
 * without leaving the list.
 *
 * Every container on the shipment is a row: loaded or not, its own ETA, its
 * documents, arrived or not, received or not, each changed where it stands.
 * Tick several and the same change applies to all of them; each still gets its
 * own history line. The shipment page, the purchase order and the loading
 * sheet read the very records this changes, so they agree the moment it saves.
 */
export function QuickUpdatePanel(props: {
  contractId: string;
  contractLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent?: QuickIntent;
}) {
  if (!props.open) return null;
  return <QuickUpdateBody {...props} />;
}

function QuickUpdateBody({
  contractId,
  contractLabel,
  onOpenChange,
  intent = null,
}: {
  contractId: string;
  contractLabel: string;
  onOpenChange: (open: boolean) => void;
  intent?: QuickIntent;
}) {
  const router = useRouter();
  const wide = useWide();
  const [order, setOrder] = React.useState<QuickOrder | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulk, setBulk] = React.useState<Bulk>(null);
  const [busy, setBusy] = React.useState(false);
  const [problems, setProblems] = React.useState<Array<{ name: string; message: string }>>([]);

  // Bulk forms
  const [loadForm, setLoadForm] = React.useState({
    loadingDate: todayInputValue(),
    etaDate: '',
    shippingLineId: '',
    bookingNumber: '',
    billOfLading: '',
    portOfLoading: '',
    portOfDischarge: '',
    notes: '',
  });
  const [bulkEta, setBulkEta] = React.useState('');
  const [bulkDocs, setBulkDocs] = React.useState({ toStatus: 'DRAFT_PENDING', workingWith: '', responsible: '', document: '', reference: '', receivedOn: '', memo: '' });
  const [bulkAta, setBulkAta] = React.useState(todayInputValue());

  // One-container dialogs
  const [loadingOne, setLoadingOne] = React.useState<QuickContainer | null>(null);
  const [docsOne, setDocsOne] = React.useState<QuickContainer | null>(null);
  const [containersOne, setContainersOne] = React.useState<QuickContainer | null>(null);
  const [undoOne, setUndoOne] = React.useState<QuickContainer | null>(null);
  const [arriving, setArriving] = React.useState<{ id: string; date: string } | null>(null);
  const [receiveIds, setReceiveIds] = React.useState<string[] | null>(null);
  const [historyFor, setHistoryFor] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<ContainerHistoryRow[] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [unArriving, setUnArriving] = React.useState<QuickContainer | null>(null);
  const [editing, setEditing] = React.useState<EditableContainer | null>(null);
  const [removing, setRemoving] = React.useState<QuickContainer | null>(null);
  const intentApplied = React.useRef(false);

  const receive = React.useCallback((result: Awaited<ReturnType<typeof getQuickUpdateAction>>) => {
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setOrder(result.data);
    // The row's own button decides what the panel opens ready to do — once.
    if (!intentApplied.current) {
      intentApplied.current = true;
      const containers = result.data.containers;
      const ids = (pick: (c: QuickContainer) => boolean) => new Set(containers.filter(pick).map((c) => c.shipmentId));
      if (intent === 'load') {
        setSelected(ids((c) => !isLoaded(c)));
        setBulk('load');
      } else if (intent === 'arrive') {
        setSelected(ids((c) => isLoaded(c) && !isArrived(c)));
        setBulk('arrive');
      } else if (intent === 'eta' || intent === 'documents') {
        setSelected(ids(() => true));
        setBulk(intent);
      } else if (intent === 'receive') {
        const ready = containers.filter((c) => isArrived(c) && !fully(c)).map((c) => c.shipmentId);
        if (ready.length > 0) setReceiveIds(ready);
      }
    }
  }, [intent]);

  // Read on opening; the panel is mounted only while it is open.
  React.useEffect(() => {
    let live = true;
    safely(getQuickUpdateAction(contractId)).then((result) => {
      if (live) receive(result);
    });
    return () => {
      live = false;
    };
  }, [contractId, receive]);

  /** After any change: this panel and the list behind it read the records again. */
  async function refreshAll() {
    receive(await safely(getQuickUpdateAction(contractId)));
    router.refresh();
  }

  async function apply(ids: string[], change: Record<string, unknown>, label: string): Promise<boolean> {
    if (!order) return false;
    setBusy(true);
    const result = await safely(quickUpdateContainersAction(JSON.stringify({ contractId, shipmentIds: ids, change })));
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return false;
    }
    const byId = new Map(order.containers.map((c) => [c.shipmentId, c]));
    const failed = result.data.filter((r) => !r.ok);
    const done = result.data.filter((r) => r.ok && !r.skipped).length;
    setProblems(failed.map((f) => ({ name: byId.get(f.shipmentId) ? nameOf(byId.get(f.shipmentId)!) : 'A container', message: f.message })));
    if (done > 0) toast.success(`${label} — ${done} container${done === 1 ? '' : 's'}.`);
    else if (failed.length === 0) toast.message(result.data[0]?.message ?? 'Nothing needed changing.');
    if (failed.length > 0) toast.error(`${failed.length} container${failed.length === 1 ? '' : 's'} could not be updated — see why above the table.`);
    await refreshAll();
    return failed.length === 0;
  }

  async function openHistory(id: string) {
    if (historyFor === id) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(id);
    setHistory(null);
    const result = await safely(getContainerHistoryAction(id));
    setHistory(result.ok ? result.data : []);
    if (!result.ok) toast.error(result.error);
  }

  function clickLoaded(c: QuickContainer) {
    if (isLoaded(c)) return;
    // Everything loading needs is already known: one click. Otherwise ask for it.
    if (readyToLoad(c)) void apply([c.shipmentId], { op: 'loaded', loadingDate: todayInputValue() }, 'Marked loaded');
    else setLoadingOne(c);
  }

  function clickNotLoaded(c: QuickContainer) {
    if (stageOf(c) === 'LOADED') setUndoOne(c);
  }

  const containers = order?.containers ?? [];
  const canUpdate = order?.canUpdate ?? false;
  const canReceive = order?.canReceive ?? false;
  const summary = summariseContainers(
    containers.map((c) => ({
      stage: stageOf(c),
      containers: Math.max(c.containers, 1),
      documentStatus: c.documentStatus,
      etaIso: c.etaIso,
      partlyReceived: Number(c.receivedKg) > 0 && !fully(c),
    })),
  );
  const allSelected = containers.length > 0 && containers.every((c) => selected.has(c.shipmentId));
  const selectedIds = containers.filter((c) => selected.has(c.shipmentId)).map((c) => c.shipmentId);
  const arrivedNotReceived = containers.filter((c) => isArrived(c) && !fully(c));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function startReceive(ids: string[]) {
    const ready = ids.filter((id) => {
      const c = containers.find((x) => x.shipmentId === id);
      return c && isArrived(c) && !fully(c);
    });
    if (ready.length === 0) {
      toast.error('Tick containers that have arrived and are not yet received.');
      return;
    }
    setReceiveIds(ready);
  }

  // --- The controls, one container at a time --------------------------------

  const loadControl = (c: QuickContainer) => {
    const loaded = isLoaded(c);
    const locked = !canUpdate || stageOf(c) === 'ARRIVED' || stageOf(c) === 'RECEIVED';
    return (
      <div className="inline-flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label={`Load status ${nameOf(c)}`}>
        <button
          type="button"
          aria-pressed={!loaded}
          disabled={locked || busy || !loaded}
          onClick={() => clickNotLoaded(c)}
          title={stageOf(c) === 'LOADED' ? 'Undo loading' : undefined}
          className={cn('px-2 py-1 text-xs font-medium', !loaded ? 'bg-forest-800 text-white' : 'bg-surface text-ink-muted hover:bg-forest-50', 'disabled:cursor-default')}
        >
          Not loaded
        </button>
        <button
          type="button"
          aria-pressed={loaded}
          disabled={locked || busy || loaded}
          onClick={() => clickLoaded(c)}
          title={loaded ? undefined : readyToLoad(c) ? 'Mark loaded today' : 'Enter the loading details'}
          className={cn('border-l border-line-strong px-2 py-1 text-xs font-medium', loaded ? 'bg-forest-800 text-white' : 'bg-surface text-ink-muted hover:bg-forest-50', 'disabled:cursor-default')}
        >
          Loaded
        </button>
      </div>
    );
  };

  const etaControl = (c: QuickContainer) => (
    <EtaInput
      key={`${c.shipmentId}:${c.etaIso ?? ''}`}
      label={nameOf(c)}
      initial={c.etaIso}
      disabled={!canUpdate || busy}
      onSave={(iso) => apply([c.shipmentId], { op: 'eta', etaDate: iso ?? '' }, 'ETA updated').then(() => undefined)}
    />
  );

  const docsControl = (c: QuickContainer) => (
    <div className="min-w-44 space-y-1">
      {canUpdate ? (
        <Select
          aria-label={`Documents ${nameOf(c)}`}
          value={c.documentStatus}
          disabled={busy}
          onChange={(e) => void apply([c.shipmentId], { op: 'documents', toStatus: e.target.value }, 'Documents updated')}
          className="h-9 text-xs"
        >
          {documentStatusOptions(c.documentStatus).map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_STATUS_META[value]?.label ?? value}
            </option>
          ))}
        </Select>
      ) : (
        <Badge tone={DOCUMENT_STATUS_META[c.documentStatus]?.tone ?? 'neutral'}>{documentLabel(c.documentStatus)}</Badge>
      )}
      <p className="text-[11px] leading-snug text-ink-muted">{DOCUMENT_STATUS_HINT[c.documentStatus] ?? ''}</p>
      {c.documentNote?.notes ? (
        <p className="text-[11px] leading-snug text-ink-subtle" title={`${c.documentNote.changedBy}, ${formatDateTime(c.documentNote.changedAt)}`}>
          {c.documentNote.notes}
        </p>
      ) : null}
      {canUpdate ? (
        <button type="button" onClick={() => setDocsOne(c)} className="text-[11px] font-medium text-forest-700 underline-offset-2 hover:underline">
          Add details
        </button>
      ) : null}
    </div>
  );

  const arrivalControl = (c: QuickContainer) => {
    if (isArrived(c)) {
      return (
        <span className="block">
          <Badge tone="progress">Arrived</Badge>
          {c.ataIso ? <span className="mt-0.5 block text-[11px] text-ink-subtle">{formatDate(c.ataIso)}</span> : null}
          {canUpdate && Number(c.receivedKg) === 0 ? (
            <button
              type="button"
              onClick={() => setUnArriving(c)}
              className="mt-0.5 block text-[11px] font-medium text-forest-700 underline-offset-2 hover:underline"
            >
              Undo arrival
            </button>
          ) : null}
        </span>
      );
    }
    if (arriving?.id === c.shipmentId) {
      return (
        <div className="flex flex-wrap items-center gap-1">
          <Input
            type="date"
            aria-label={`Arrival date ${nameOf(c)}`}
            value={arriving.date}
            onChange={(e) => setArriving({ id: c.shipmentId, date: e.target.value })}
            className="h-8 w-36 text-xs"
          />
          <Button
            size="sm"
            disabled={busy || !arriving.date}
            onClick={async () => {
              const done = await apply([c.shipmentId], { op: 'arrived', ataDate: arriving.date }, 'Marked arrived');
              if (done) setArriving(null);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setArriving(null)}>
            Cancel
          </Button>
        </div>
      );
    }
    return (
      <span className="block">
        <span className="block text-xs text-ink-muted">Not arrived</span>
        {canUpdate ? (
          <button
            type="button"
            onClick={() => setArriving({ id: c.shipmentId, date: todayInputValue() })}
            className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-forest-700 underline-offset-2 hover:underline"
          >
            <Anchor className="size-3" />
            Mark arrived
          </button>
        ) : null}
      </span>
    );
  };

  const receiptCell = (c: QuickContainer) => {
    const received = Number(c.receivedKg);
    return (
      <span className="block text-xs">
        {fully(c) ? (
          <Badge tone="success">Received</Badge>
        ) : received > 0 ? (
          <Badge tone="warning">
            Part received {formatQuantityKg(received)} of {formatQuantityKg(c.orderedKg)}
          </Badge>
        ) : (
          <span className="text-ink-muted">Not received</span>
        )}
        {c.warehouseNames ? <span className="mt-0.5 block text-[11px] text-ink-subtle">{c.warehouseNames}</span> : null}
      </span>
    );
  };

  const rowButtons = (c: QuickContainer) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {canReceive && isArrived(c) && !fully(c) ? (
        <Button size="sm" onClick={() => setReceiveIds([c.shipmentId])}>
          <PackageCheck />
          Receive
        </Button>
      ) : null}
      {Number(c.receivedKg) > 0 && c.lines[0] ? (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/inventory/batches/${c.lines[0].batchId}`}>View receipt</Link>
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void openHistory(c.shipmentId)} aria-expanded={historyFor === c.shipmentId}>
        <History />
        History
      </Button>
      {order?.canRemove && Number(c.receivedKg) === 0 && c.lines.length === 1 ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setEditing({
              shipmentId: c.shipmentId,
              label: nameOf(c),
              quantityKg: c.lines[0].orderedKg,
              containerNumber: c.lines[0].containerNumber,
              lotNumber: c.lines[0].lotNumber,
              batchNumber: c.lines[0].batchNumber,
            })
          }
        >
          <Pencil />
          Edit
        </Button>
      ) : null}
      {canUpdate && isLoaded(c) && !fully(c) ? (
        <Button size="sm" variant="ghost" onClick={() => setContainersOne(c)}>
          <Boxes />
          Containers
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" asChild>
        <Link href={`/shipments/${c.shipmentId}`}>
          <Eye />
          Open
        </Link>
      </Button>
      {order?.canRemove && containers.length > 1 && Number(c.receivedKg) === 0 ? (
        <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" onClick={() => setRemoving(c)}>
          <Trash2 />
          Remove container
        </Button>
      ) : null}
    </div>
  );

  const historyList = (
    <div className="space-y-1 text-xs" data-testid="container-history">
      {history === null ? (
        <p className="flex items-center gap-1 text-ink-subtle">
          <Loader2 className="size-3 animate-spin" /> Reading the history…
        </p>
      ) : history.length === 0 ? (
        <p className="text-ink-subtle">Nothing recorded yet.</p>
      ) : (
        history.map((h, i) => (
          <p key={`${h.at}-${i}`} className="flex flex-wrap gap-x-2">
            <span className="tnum text-ink-subtle">{formatDateTime(h.at)}</span>
            <span className="font-medium">{h.what}</span>
            <span>
              {describe(h.what, h.from)} → {describe(h.what, h.to)}
            </span>
            <span className="text-ink-muted">by {h.by}</span>
            {h.notes ? <span className="text-ink-muted">· {h.notes}</span> : null}
          </p>
        ))
      )}
    </div>
  );

  // --- The bulk forms ---------------------------------------------------------

  const bulkForm =
    bulk === 'load' ? (
      <BulkCard
        title={`Mark ${selectedIds.length} container${selectedIds.length === 1 ? '' : 's'} loaded`}
        hint="Blank fields keep what each container already has. Each container must end up with an ETA, a shipping line and a booking, B/L or container number."
        busy={busy}
        disabled={selectedIds.length === 0}
        applyLabel="Mark loaded"
        onCancel={() => setBulk(null)}
        onApply={async () => {
          const done = await apply(selectedIds, { op: 'loaded', ...loadForm }, 'Marked loaded');
          if (done) setBulk(null);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Loading date" htmlFor="qLoadDate" required>
            <Input id="qLoadDate" type="date" value={loadForm.loadingDate} onChange={(e) => setLoadForm((f) => ({ ...f, loadingDate: e.target.value }))} />
          </Field>
          <Field label="ETA" htmlFor="qLoadEta">
            <Input id="qLoadEta" type="date" value={loadForm.etaDate} onChange={(e) => setLoadForm((f) => ({ ...f, etaDate: e.target.value }))} />
          </Field>
          <Field label="Shipping line" htmlFor="qLoadLine">
            <Select id="qLoadLine" value={loadForm.shippingLineId} onChange={(e) => setLoadForm((f) => ({ ...f, shippingLineId: e.target.value }))}>
              <option value="">Keep each container&rsquo;s</option>
              {(order?.shippingLines ?? []).map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Booking" htmlFor="qLoadBooking">
            <Input id="qLoadBooking" value={loadForm.bookingNumber} onChange={(e) => setLoadForm((f) => ({ ...f, bookingNumber: e.target.value }))} />
          </Field>
          <Field label="B/L" htmlFor="qLoadBl">
            <Input id="qLoadBl" value={loadForm.billOfLading} onChange={(e) => setLoadForm((f) => ({ ...f, billOfLading: e.target.value }))} />
          </Field>
          <Field label="Port of loading" htmlFor="qLoadPol">
            <Input id="qLoadPol" list="qPorts" value={loadForm.portOfLoading} onChange={(e) => setLoadForm((f) => ({ ...f, portOfLoading: e.target.value }))} />
          </Field>
          <Field label="Port of discharge" htmlFor="qLoadPod">
            <Input id="qLoadPod" list="qPorts" value={loadForm.portOfDischarge} onChange={(e) => setLoadForm((f) => ({ ...f, portOfDischarge: e.target.value }))} />
          </Field>
          <Field label="Memo" htmlFor="qLoadMemo">
            <Input id="qLoadMemo" value={loadForm.notes} onChange={(e) => setLoadForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          <datalist id="qPorts">
            {(order?.ports ?? []).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
      </BulkCard>
    ) : bulk === 'eta' ? (
      <BulkCard
        title={`New ETA for ${selectedIds.length} container${selectedIds.length === 1 ? '' : 's'}`}
        hint="Each container keeps its own history of every ETA it has had."
        busy={busy}
        disabled={selectedIds.length === 0 || !bulkEta}
        applyLabel="Update ETA"
        onCancel={() => setBulk(null)}
        onApply={async () => {
          const done = await apply(selectedIds, { op: 'eta', etaDate: bulkEta }, 'ETA updated');
          if (done) setBulk(null);
        }}
      >
        <Field label="ETA" htmlFor="qBulkEta" required className="w-48">
          <Input id="qBulkEta" type="date" value={bulkEta} onChange={(e) => setBulkEta(e.target.value)} />
        </Field>
      </BulkCard>
    ) : bulk === 'documents' ? (
      <BulkCard
        title={`Documents for ${selectedIds.length} container${selectedIds.length === 1 ? '' : 's'}`}
        hint="The note is kept in each container's document history."
        busy={busy}
        disabled={selectedIds.length === 0}
        applyLabel="Update documents"
        onCancel={() => setBulk(null)}
        onApply={async () => {
          const notes = composeDocumentNote({ workingWith: bulkDocs.workingWith, responsible: bulkDocs.responsible, document: bulkDocs.document, reference: bulkDocs.reference, receivedOn: bulkDocs.receivedOn, memo: bulkDocs.memo });
          const done = await apply(selectedIds, { op: 'documents', toStatus: bulkDocs.toStatus, notes }, 'Documents updated');
          if (done) setBulk(null);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Status" htmlFor="qDocStatus" required>
            <Select id="qDocStatus" value={bulkDocs.toStatus} onChange={(e) => setBulkDocs((d) => ({ ...d, toStatus: e.target.value }))}>
              {DOCUMENT_STATUS_CHOICES.map((value) => (
                <option key={value} value={value}>
                  {DOCUMENT_STATUS_META[value].label} — {DOCUMENT_STATUS_HINT[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Working with" htmlFor="qDocWith">
            <Select id="qDocWith" value={bulkDocs.workingWith} onChange={(e) => setBulkDocs((d) => ({ ...d, workingWith: e.target.value }))}>
              <option value="">—</option>
              {WORKING_WITH.map((who) => (
                <option key={who} value={who}>
                  {who}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsible person" htmlFor="qDocWho">
            <Input id="qDocWho" value={bulkDocs.responsible} onChange={(e) => setBulkDocs((d) => ({ ...d, responsible: e.target.value }))} />
          </Field>
          <Field label="Document" htmlFor="qDocName">
            <Input id="qDocName" value={bulkDocs.document} onChange={(e) => setBulkDocs((d) => ({ ...d, document: e.target.value }))} placeholder="Original B/L" />
          </Field>
          <Field label="Reference" htmlFor="qDocRef">
            <Input id="qDocRef" value={bulkDocs.reference} onChange={(e) => setBulkDocs((d) => ({ ...d, reference: e.target.value }))} />
          </Field>
          <Field label="Received date" htmlFor="qDocDate">
            <Input id="qDocDate" type="date" value={bulkDocs.receivedOn} onChange={(e) => setBulkDocs((d) => ({ ...d, receivedOn: e.target.value }))} />
          </Field>
          <Field label="Memo" htmlFor="qDocMemo">
            <Input id="qDocMemo" value={bulkDocs.memo} onChange={(e) => setBulkDocs((d) => ({ ...d, memo: e.target.value }))} placeholder="Waiting for original BL" />
          </Field>
        </div>
      </BulkCard>
    ) : bulk === 'arrive' ? (
      <BulkCard
        title={`Mark ${selectedIds.length} container${selectedIds.length === 1 ? '' : 's'} arrived`}
        hint="Containers already arrived are left as they are. A container nobody marked loaded is stepped through Loaded first."
        busy={busy}
        disabled={selectedIds.length === 0 || !bulkAta}
        applyLabel="Mark arrived"
        onCancel={() => setBulk(null)}
        onApply={async () => {
          const done = await apply(selectedIds, { op: 'arrived', ataDate: bulkAta }, 'Marked arrived');
          if (done) setBulk(null);
        }}
      >
        <Field label="Arrival date" htmlFor="qBulkAta" required className="w-48">
          <Input id="qBulkAta" type="date" value={bulkAta} onChange={(e) => setBulkAta(e.target.value)} />
        </Field>
      </BulkCard>
    ) : null;

  const receiveBatches = (receiveIds ?? []).flatMap((id) => {
    const c = containers.find((x) => x.shipmentId === id);
    if (!c) return [];
    return receivableBatches({
      status: c.status,
      shipmentOrdinal: c.ordinal,
      containerNumbers: c.containerNumbers,
      lines: c.lines.map((l) => ({
        batchId: l.batchId,
        batchNumber: l.batchNumber,
        itemName: l.itemName,
        lotNumber: l.lotNumber,
        containerNumber: l.containerNumber,
        quantityKg: Number(l.orderedKg),
        receivedKg: Number(l.receivedKg),
        bagWeightKg: l.bagWeightKg,
        traceabilityPending: l.traceabilityPending,
      })),
    });
  });

  return (
    <>
      <Sheet
        open
        onOpenChange={onOpenChange}
        width="full"
        title={`Quick Update — ${contractLabel}`}
        description={order ? `${order.contract.supplier} · ${summary.total} container${summary.total === 1 ? '' : 's'}` : 'Reading the containers…'}
      >
        <div className="space-y-4" data-testid="quick-update">
          {loadError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{loadError}</p>
          ) : null}
          {!order && !loadError ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" /> Reading the containers…
            </p>
          ) : null}

          {order ? (
            <>
              <div className="flex flex-wrap items-center gap-2" data-testid="quick-summary">
                <Badge tone={summary.loaded === summary.total ? 'success' : summary.loaded > 0 ? 'info' : 'neutral'} data-summary="loading">
                  {summary.loadingLabel}
                </Badge>
                <Badge tone={ARRIVAL_STATE_META[summary.arrivalState].tone} data-summary="arrival">
                  {summary.arrivalLabel}
                </Badge>
                <Badge tone={RECEIPT_STATE_META[summary.receiptState].tone} data-summary="receipt">
                  {summary.receiptLabel}
                </Badge>
                <span className="text-xs text-ink-muted" data-summary="documents">
                  Documents: {summary.documentsLabel}
                </span>
                <span className="text-xs text-ink-muted" data-summary="eta">
                  ETA: {summary.etaLabel}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/purchases/${contractId}`}>
                      <FileText />
                      Purchase order
                    </Link>
                  </Button>
                  {order.canDelete ? (
                    <Button size="sm" variant="outline" className="text-red-700 hover:border-red-300 hover:bg-red-50" onClick={() => setDeleting(true)}>
                      <Trash2 />
                      Delete shipment
                    </Button>
                  ) : null}
                </span>
              </div>

              {canUpdate || canReceive ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-sunken/40 p-2" data-testid="quick-bulk">
                  <label className="mr-1 flex items-center gap-2 text-xs font-medium text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-gold-600"
                      checked={allSelected}
                      onChange={(e) => setSelected(e.target.checked ? new Set(containers.map((c) => c.shipmentId)) : new Set())}
                    />
                    Select all containers ({containers.length})
                  </label>
                  <span className="text-xs text-ink-subtle">{selectedIds.length} ticked</span>
                  {canUpdate ? (
                    <>
                      <Button size="sm" variant={bulk === 'load' ? 'subtle' : 'outline'} disabled={selectedIds.length === 0} onClick={() => setBulk('load')}>
                        <Ship />
                        Mark selected loaded
                      </Button>
                      <Button size="sm" variant={bulk === 'eta' ? 'subtle' : 'outline'} disabled={selectedIds.length === 0} onClick={() => setBulk('eta')}>
                        <CalendarClock />
                        Update ETA
                      </Button>
                      <Button size="sm" variant={bulk === 'documents' ? 'subtle' : 'outline'} disabled={selectedIds.length === 0} onClick={() => setBulk('documents')}>
                        <FileText />
                        Update documents
                      </Button>
                      <Button size="sm" variant={bulk === 'arrive' ? 'subtle' : 'outline'} disabled={selectedIds.length === 0} onClick={() => setBulk('arrive')}>
                        <Anchor />
                        Mark selected arrived
                      </Button>
                    </>
                  ) : null}
                  {canReceive ? (
                    <>
                      <Button size="sm" variant="outline" disabled={selectedIds.length === 0} onClick={() => startReceive(selectedIds)}>
                        <PackageCheck />
                        Receive selected
                      </Button>
                      <Button size="sm" disabled={arrivedNotReceived.length === 0} onClick={() => startReceive(arrivedNotReceived.map((c) => c.shipmentId))}>
                        <PackageCheck />
                        Receive all arrived ({arrivedNotReceived.length})
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}

              {bulkForm}

              {problems.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="quick-problems">
                  <p className="font-medium">Not every container could be updated:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {problems.map((p, i) => (
                      <li key={`${p.name}-${i}`}>
                        <span className="font-mono">{p.name}</span>: {p.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {wide ? (
                <div className="overflow-x-auto rounded-xl border border-grid">
                  <table className="data-grid w-full min-w-[68rem] text-sm" data-testid="quick-table">
                    <thead className="bg-surface">
                      <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-ink">
                        <th className="w-8 px-2 py-2" aria-label="Select" />
                        <th className="px-3 py-2">Container</th>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2 text-right">KG</th>
                        <th className="px-3 py-2">Load status</th>
                        <th className="px-3 py-2">ETA</th>
                        <th className="px-3 py-2">Documents</th>
                        <th className="px-3 py-2">Arrival</th>
                        <th className="px-3 py-2">Receipt</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {containers.map((c) => (
                        <React.Fragment key={c.shipmentId}>
                          <tr className="align-top" data-container={nameOf(c)} data-stage={stageOf(c)}>
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                aria-label={`Select ${nameOf(c)}`}
                                className="size-4 accent-gold-600"
                                checked={selected.has(c.shipmentId)}
                                onChange={(e) => toggle(c.shipmentId, e.target.checked)}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <span className="block font-mono text-xs font-medium">{nameOf(c)}</span>
                              <span className="block text-[11px] text-ink-subtle">
                                Shipment {c.ordinal} of {c.shipmentsOnOrder}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              {[...new Set(c.lines.map((l) => l.itemName))].join(', ')}
                              <span className="block text-[11px] text-ink-subtle">{c.lines.map((l) => `${l.lotNumber} / ${l.batchNumber}`).join(', ')}</span>
                            </td>
                            <td className="tnum px-3 py-2 text-right whitespace-nowrap">{formatQuantityKg(c.orderedKg)}</td>
                            <td className="px-3 py-2">{loadControl(c)}</td>
                            <td className="px-3 py-2">{etaControl(c)}</td>
                            <td className="px-3 py-2">{docsControl(c)}</td>
                            <td className="px-3 py-2">{arrivalControl(c)}</td>
                            <td className="px-3 py-2">{receiptCell(c)}</td>
                            <td className="px-3 py-2">{rowButtons(c)}</td>
                          </tr>
                          {historyFor === c.shipmentId ? (
                            <tr>
                              <td colSpan={10} className="bg-surface-sunken/50 px-4 py-2">
                                {historyList}
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-3" data-testid="quick-cards">
                  {containers.map((c) => (
                    <div key={c.shipmentId} className="space-y-3 rounded-xl border border-grid p-3" data-container={nameOf(c)} data-stage={stageOf(c)}>
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${nameOf(c)}`}
                            className="mt-0.5 size-4 accent-gold-600"
                            checked={selected.has(c.shipmentId)}
                            onChange={(e) => toggle(c.shipmentId, e.target.checked)}
                          />
                          <span>
                            <span className="block font-mono text-sm font-medium">{nameOf(c)}</span>
                            <span className="block text-xs text-ink-muted">
                              {[...new Set(c.lines.map((l) => l.itemName))].join(', ')} · {formatQuantityKg(c.orderedKg)}
                            </span>
                          </span>
                        </label>
                        <Badge tone={CONTAINER_STAGE_META[stageOf(c)].tone}>{CONTAINER_STAGE_META[stageOf(c)].label}</Badge>
                      </div>
                      <dl className="grid grid-cols-[6.5rem_1fr] items-start gap-x-3 gap-y-2 text-sm">
                        <dt className="pt-1 text-xs text-ink-muted">Load</dt>
                        <dd>{loadControl(c)}</dd>
                        <dt className="pt-1 text-xs text-ink-muted">ETA</dt>
                        <dd>{etaControl(c)}</dd>
                        <dt className="pt-1 text-xs text-ink-muted">Documents</dt>
                        <dd>{docsControl(c)}</dd>
                        <dt className="pt-1 text-xs text-ink-muted">Arrival</dt>
                        <dd>{arrivalControl(c)}</dd>
                        <dt className="pt-1 text-xs text-ink-muted">Receipt</dt>
                        <dd>{receiptCell(c)}</dd>
                      </dl>
                      {rowButtons(c)}
                      {historyFor === c.shipmentId ? historyList : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </Sheet>

      {loadingOne && order ? (
        <MarkLoadedDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setLoadingOne(null);
              void refreshAll();
            }
          }}
          shipmentId={loadingOne.shipmentId}
          contractLabel={`${contractLabel} · ${nameOf(loadingOne)}`}
          shippingLines={order.shippingLines}
          ports={order.ports}
          defaults={{
            etaDate: loadingOne.etaIso,
            bookingNumber: loadingOne.bookingNumber,
            billOfLading: loadingOne.billOfLading,
            shippingLineId: loadingOne.shippingLineId,
            portOfLoading: loadingOne.portOfLoading,
            portOfDischarge: loadingOne.portOfDischarge,
            containerNumbers: loadingOne.containerNumbers,
            containers: loadingOne.containers,
          }}
        />
      ) : null}

      {docsOne ? (
        <DocumentStatusDialog
          shipmentId={docsOne.shipmentId}
          contractLabel={`${contractLabel} · ${nameOf(docsOne)}`}
          currentStatus={docsOne.documentStatus}
          onClose={() => {
            setDocsOne(null);
            void refreshAll();
          }}
        />
      ) : null}

      {containersOne ? (
        <ManageContainersDialog
          shipmentId={containersOne.shipmentId}
          contractLabel={`${contractLabel} · Shipment ${containersOne.ordinal}`}
          lines={containersOne.lines.map((l) => ({
            batchId: l.batchId,
            itemName: l.itemName,
            quantity: formatQuantityKg(l.orderedKg),
            batchNumber: l.batchNumber,
            lotNumber: l.lotNumber,
            containerNumber: l.containerNumber,
            traceabilityPending: l.traceabilityPending,
          }))}
          knownNumbers={containersOne.containerNumbers}
          onClose={() => {
            setContainersOne(null);
            void refreshAll();
          }}
        />
      ) : null}

      {order && receiveIds ? (
        <GoodsReceiptDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setReceiveIds(null);
              void refreshAll();
            }
          }}
          purchaseContractId={contractId}
          contractLabel={contractLabel}
          batches={receiveBatches}
          warehouses={order.warehouses}
          defaultWarehouseId={order.defaultWarehouseId}
        />
      ) : null}

      <ConfirmDialog
        open={undoOne !== null}
        onOpenChange={(open) => {
          if (!open) setUndoOne(null);
        }}
        title={undoOne ? `Return ${nameOf(undoOne)} to Not loaded?` : ''}
        description="So that its loading details can be corrected and it can be marked loaded again. The shipping line, booking and dates are kept. Refused once the coffee is in stock — that is corrected on the purchase order."
        confirmLabel="Undo loading"
        onConfirm={async () => {
          if (!undoOne) return;
          const result = await safely(undoLoadingAction(undoOne.shipmentId, ''));
          if (!result || !result.ok) throw new Error(result?.error ?? 'The loading could not be undone.');
          toast.success(`${nameOf(undoOne)} is back to Not loaded.`);
          await refreshAll();
        }}
      />

      <EditContainerDialog
        container={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refreshAll();
        }}
      />

      <ConfirmDialog
        open={unArriving !== null}
        onOpenChange={(open) => {
          if (!open) setUnArriving(null);
        }}
        title={unArriving ? `Move ${nameOf(unArriving)} back to Not arrived?` : ''}
        description="For a container marked arrived by mistake. It goes back to Loaded and its arrival date is cleared; the change is kept in its history. Refused once a goods receipt exists for it."
        confirmLabel="Undo arrival"
        onConfirm={async () => {
          if (!unArriving) return;
          const result = await safely(undoArrivalAction(unArriving.shipmentId, ''));
          if (!result || !result.ok) throw new Error(result?.error ?? 'The arrival could not be undone.');
          toast.success(`${nameOf(unArriving)} is back to Not arrived.`);
          await refreshAll();
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove container ${nameOf(removing)} from ${contractLabel}?` : ''}
        description="The container is taken off the order: the supplier is owed its value less, posted as its own entry against the order (the original stays in the journal), and its row, shipment, batch and lot are removed. A full copy goes to the audit log. Refused once anything has been received, costed, sold or paid against it."
        confirmLabel="Remove container"
        variant="danger"
        requireReason
        reasonLabel="Why is this container being removed?"
        onConfirm={async (reason) => {
          if (!removing) return;
          const result = await safely(removeContainerAction(removing.shipmentId, reason));
          if (!result.ok) throw new Error(result.error);
          toast.success(`Container ${nameOf(removing)} removed from the order.`);
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(removing.shipmentId);
            return next;
          });
          await refreshAll();
        }}
      />

      <DeleteShipmentDialog
        open={deleting}
        contractId={contractId}
        label={contractLabel}
        onOpenChange={setDeleting}
        onDeleted={() => onOpenChange(false)}
      />
    </>
  );
}

/** "ARRIVED" → "Arrived"; a date → "12 Oct 2026"; document codes in the client's words. */
function describe(what: string, value: string | null): string {
  if (!value) return '—';
  if (what === 'ETA') return formatDate(value);
  if (what === 'Documents') return documentLabel(value);
  if (what === 'Status') {
    const words = value.replaceAll('_', ' ').toLowerCase();
    return words[0].toUpperCase() + words.slice(1);
  }
  return value;
}

/**
 * An ETA that saves itself: pick a date and it is recorded — no Save button,
 * no page. A typed date is saved once it is a whole date and the typing has
 * paused, or when the field is left, and never twice for the same value.
 */
function EtaInput({
  label,
  initial,
  disabled,
  onSave,
}: {
  label: string;
  initial: string | null;
  disabled: boolean;
  onSave: (iso: string | null) => Promise<void>;
}) {
  const [value, setValue] = React.useState(initial ?? '');
  const saved = React.useRef(initial ?? '');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function commit(next: string) {
    if (timer.current) clearTimeout(timer.current);
    if (next === saved.current) return;
    if (next && (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number(next.slice(0, 4)) < 2000)) return;
    saved.current = next;
    void onSave(next || null);
  }

  return (
    <Input
      type="date"
      aria-label={`ETA ${label}`}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(next), 700);
      }}
      onBlur={(e) => commit(e.target.value)}
      className="h-9 w-40 text-xs"
    />
  );
}

function BulkCard({
  title,
  hint,
  children,
  busy,
  disabled,
  applyLabel,
  onApply,
  onCancel,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
  busy: boolean;
  disabled: boolean;
  applyLabel: string;
  onApply: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-forest-200 bg-forest-50/40 p-3" data-testid="quick-bulk-form">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-xs text-ink-muted">{hint}</p>
      </div>
      {children}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void onApply()} loading={busy} disabled={disabled || busy}>
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}
