'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Copy, Download, ExternalLink, ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { useShareEnv } from '@/components/share/share-context';
import { formatDate } from '@/lib/format';
import { createShareLinkAction, logShareEventsAction } from '@/server/actions/share-actions';
import {
  SHARE_EXPIRY,
  SHARE_EXPIRY_LABEL,
  shareFileName,
  shareHeadline,
  snapshotRowCount,
  whatsappMessage,
  whatsappUrl,
  type ShareEvent,
  type ShareExpiry,
  type ShareFormat,
  type ShareMeta,
  type ShareMethod,
  type ShareReportKey,
  type ShareSection,
  type ShareSnapshot,
} from '@/lib/share/model';

/**
 * Share Report on WhatsApp — one dialog for every report in the application.
 *
 * The page says what it can offer (the current filtered report, the page on
 * screen, the whole period, a date range, the rows ticked) and how to build
 * each from what it already shows. The dialog asks what to share and in what
 * form, builds the one snapshot, and:
 *
 *   PDF, on a phone that can hand a file to another app — the phone's own
 *   share sheet opens with the PDF attached; WhatsApp is one of the apps in it.
 *   Otherwise — a secure, expiring, read-only link is made and WhatsApp (or
 *   WhatsApp Web) opens with a message carrying it; nothing to copy.
 *
 * Each step is recorded for the share log as what it was — "WhatsApp opened",
 * "Share sheet opened" — and never as "sent", which the application cannot know.
 */

export type ShareScope = { key: string; label: string; hint?: string };
export type ShareToggle = { key: string; label: string; checked: boolean };

export type ShareChoice = {
  scope: string;
  columns: string[];
  extras: Record<string, boolean>;
  sections: string[];
  from: string;
  to: string;
};

export type ShareBuild = {
  filters: string[];
  scopeLabel: string;
  facts: ShareSnapshot['facts'];
  sections: ShareSection[];
};

export type ShareSpec = {
  report: ShareReportKey;
  title: string;
  subject?: string;
  period?: string;
  scopes: ShareScope[];
  defaultScope: string;
  columns?: ShareToggle[];
  extras?: ShareToggle[];
  sections?: Array<{ key: string; label: string }>;
  /** Offer From/To when the scope is 'range', within these dates. */
  dateRange?: { min?: string; max?: string };
  build: (choice: ShareChoice) => ShareBuild | Promise<ShareBuild>;
  /** Turns on ticking rows in the table behind the dialog. */
  onChooseRows?: () => void;
};

export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-4 fill-[#25D366]', className)}>
      <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.08.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35zM12.05 21.8h-.01a9.8 9.8 0 0 1-5-1.37l-.36-.21-3.72.98.99-3.63-.23-.37a9.8 9.8 0 0 1-1.5-5.23C2.22 6.55 6.63 2.15 12.06 2.15c2.63 0 5.1 1.03 6.96 2.89a9.78 9.78 0 0 1 2.88 6.96c0 5.43-4.41 9.8-9.85 9.8zm8.38-18.18A11.76 11.76 0 0 0 12.05.15C5.52.15.2 5.47.2 12c0 2.09.55 4.13 1.59 5.93L.1 24l6.21-1.63a11.85 11.85 0 0 0 5.74 1.46h.01c6.53 0 11.85-5.32 11.85-11.85 0-3.17-1.23-6.14-3.47-8.38z" />
    </svg>
  );
}

/** The toolbar button: the WhatsApp mark and "Share". */
export function ShareTrigger({ onClick, className, label = 'Share' }: { onClick: () => void; className?: string; label?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn('shrink-0 gap-1.5', className)}
      aria-label="Share on WhatsApp"
      data-testid="share-whatsapp"
      data-print="hide"
    >
      <WhatsAppIcon />
      <span>{label}</span>
    </Button>
  );
}

function newShareId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `shr_${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

function canShareFiles(): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
    return navigator.canShare({ files: [new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

const day = (iso: string) => formatDate(new Date(`${iso}T00:00:00.000Z`));

function log(meta: ShareMeta, events: ShareEvent[]) {
  // Recording must never stand in the way of the share itself.
  void logShareEventsAction(meta, events).catch(() => undefined);
}

export function ShareDialog({ open, onOpenChange, spec }: { open: boolean; onOpenChange: (open: boolean) => void; spec: ShareSpec }) {
  const env = useShareEnv();
  const [scope, setScope] = React.useState(spec.defaultScope);
  const [columns, setColumns] = React.useState<string[]>(() => (spec.columns ?? []).filter((c) => c.checked).map((c) => c.key));
  const [extras, setExtras] = React.useState<Record<string, boolean>>(() => Object.fromEntries((spec.extras ?? []).map((e) => [e.key, e.checked])));
  const [sections, setSections] = React.useState<string[]>(() => (spec.sections ?? []).map((s) => s.key));
  const [from, setFrom] = React.useState(spec.dateRange?.min ?? '');
  const [to, setTo] = React.useState(spec.dateRange?.max ?? '');
  const [format, setFormat] = React.useState<ShareFormat>('PDF');
  const [expiry, setExpiry] = React.useState<ShareExpiry>('7');
  const [snapshot, setSnapshot] = React.useState<ShareSnapshot | null>(null);
  const [pdf, setPdf] = React.useState<{ blob: Blob; of: ShareSnapshot } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [link, setLink] = React.useState<{ url: string; whatsapp: string; expiresAt: string | null; meta: ShareMeta } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fileShare, setFileShare] = React.useState(false);

  React.useEffect(() => {
    // Whether this browser can hand a file to another app is only known in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a client-only capability, read once
    setFileShare(canShareFiles());
  }, []);

  // The snapshot, rebuilt whenever the choice changes.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.resolve(spec.build({ scope, columns, extras, sections, from, to }))
      .then((built) => {
        if (cancelled) return;
        setSnapshot({
          v: 1,
          company: env.company,
          title: spec.title,
          subject: spec.subject,
          period: scope === 'range' && (from || to) ? `${from ? day(from) : 'the start'} – ${to ? day(to) : 'today'}` : spec.period,
          filters: built.filters,
          scope: built.scopeLabel,
          facts: built.facts,
          sections: built.sections,
          generatedAt: new Date().toISOString(),
          generatedBy: env.userName,
        });
        setLink(null);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'The report could not be read.'));
    return () => {
      cancelled = true;
    };
  }, [open, spec, scope, columns, extras, sections, from, to, env.company, env.userName]);

  // The PDF is made ahead of the tap, so the phone's share sheet can open straight from it.
  React.useEffect(() => {
    if (!open || !snapshot) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      import('@/lib/share/pdf')
        .then(({ buildSharePdf }) => buildSharePdf(snapshot))
        .then((blob) => !cancelled && setPdf({ blob, of: snapshot }))
        .catch(() => !cancelled && setPdf(null));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, snapshot]);

  const rows = snapshot ? snapshotRowCount(snapshot) : 0;
  const pdfReady = pdf && snapshot && pdf.of === snapshot ? pdf.blob : null;
  const usesLink = format === 'LINK' || !fileShare;
  const nothing = snapshot !== null && snapshot.sections.every((s) => s.rows.length === 0) && snapshot.facts.length === 0;

  const metaFor = (fmt: ShareFormat, method: ShareMethod): ShareMeta => ({
    shareId: newShareId(),
    report: spec.report,
    title: spec.title,
    subject: spec.subject,
    period: snapshot?.period,
    filters: snapshot?.filters ?? [],
    scope: snapshot?.scope ?? '',
    rows,
    columns: snapshot?.sections[0]?.columns.map((c) => c.label).filter(Boolean) ?? [],
    format: fmt,
    method,
    page: `${window.location.pathname}${window.location.search}`.slice(0, 500),
  });

  async function shareFile() {
    if (!snapshot || !pdfReady) return;
    const meta = metaFor('PDF', 'NATIVE_SHARE');
    const file = new File([pdfReady], shareFileName(snapshot), { type: 'application/pdf' });
    // Called first, inside the tap, before anything that waits.
    const sharing = navigator.share({ files: [file], title: shareHeadline(snapshot), text: whatsappMessage(snapshot) });
    log(meta, ['SHARE_INITIATED', 'SHARE_PDF_GENERATED', 'SHARE_SHEET_OPENED']);
    try {
      await sharing;
      log(meta, ['SHARE_SHEET_HANDED_OFF']);
      toast.success('Handed to the app you chose. Finish sending it there.');
      onOpenChange(false);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        log(meta, ['SHARE_CANCELLED']);
        return;
      }
      setError('The share sheet could not open. Try the secure link instead.');
    }
  }

  async function shareLink() {
    if (!snapshot) return;
    // Opened now, while the tap still counts, so no pop-up blocker stops it; pointed at WhatsApp once the link exists.
    const win = window.open('', '_blank');
    setBusy(true);
    setError(null);
    try {
      const meta = metaFor('LINK', 'WHATSAPP');
      const result = await createShareLinkAction(meta, snapshot, expiry);
      if (!result.ok) {
        win?.close();
        setError(result.error);
        return;
      }
      const message = whatsappMessage(snapshot, result.data.url);
      const wa = whatsappUrl(message);
      setLink({ url: result.data.url, whatsapp: wa, expiresAt: result.data.expiresAt, meta });
      if (win) {
        win.opener = null;
        win.location.href = wa;
        log(meta, ['SHARE_WHATSAPP_OPENED']);
        toast.success('WhatsApp opened with the link. Choose the contact and send it there.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const current = snapshot;
      let blob: Blob;
      if (pdfReady) blob = pdfReady;
      else {
        const { buildSharePdf } = await import('@/lib/share/pdf');
        blob = await buildSharePdf(current);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = shareFileName(snapshot);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      log(metaFor('PDF', 'DOWNLOAD'), ['SHARE_INITIATED', 'SHARE_PDF_GENERATED', 'SHARE_PDF_DOWNLOADED']);
    } catch {
      setError('The PDF could not be made.');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (list: string[], key: string, on: boolean) => (on ? [...list, key] : list.filter((k) => k !== key));
  const columnOrder = (next: string[]) => (spec.columns ?? []).map((c) => c.key).filter((k) => next.includes(k));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Share Report on WhatsApp" description={shareHeadline(spec)} className="sm:w-[min(40rem,94vw)]">
        <div className="space-y-4 text-sm" data-testid="share-dialog">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-sunken/60 px-3 py-2 text-xs">
            <dt className="text-ink-muted">Report</dt>
            <dd className="font-semibold text-ink" data-testid="share-report">{shareHeadline(spec)}</dd>
            {snapshot?.period ? (
              <>
                <dt className="text-ink-muted">Period</dt>
                <dd data-testid="share-period">{snapshot.period}</dd>
              </>
            ) : null}
            {snapshot?.filters.length ? (
              <>
                <dt className="text-ink-muted">Filters</dt>
                <dd data-testid="share-filters">{snapshot.filters.join(' · ')}</dd>
              </>
            ) : null}
          </dl>

          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-semibold text-ink">What do you want to share?</legend>
            {spec.scopes.map((s) => (
              <label key={s.key} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-forest-50">
                <input
                  type="radio"
                  name="share-scope"
                  value={s.key}
                  checked={scope === s.key}
                  onChange={() => setScope(s.key)}
                  className="mt-0.5 size-4 accent-forest-700"
                  data-testid={`share-scope-${s.key}`}
                />
                <span>
                  <span className="block">{s.label}</span>
                  {s.hint ? <span className="block text-[11px] text-ink-muted">{s.hint}</span> : null}
                </span>
              </label>
            ))}
            {spec.onChooseRows ? (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  spec.onChooseRows?.();
                }}
                className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-forest-800 underline-offset-2 hover:underline"
                data-testid="share-choose-rows"
              >
                <ListChecks className="size-3.5" /> Tick the rows to share…
              </button>
            ) : null}
            {scope === 'range' ? (
              <div className="flex flex-wrap gap-2 pl-7">
                <label className="flex flex-col text-[11px] text-ink-muted">
                  From
                  <Input type="date" value={from} min={spec.dateRange?.min} max={spec.dateRange?.max} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" aria-label="Share from date" />
                </label>
                <label className="flex flex-col text-[11px] text-ink-muted">
                  To
                  <Input type="date" value={to} min={spec.dateRange?.min} max={spec.dateRange?.max} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" aria-label="Share to date" />
                </label>
              </div>
            ) : null}
          </fieldset>

          {spec.sections && spec.sections.length > 1 ? (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold text-ink">Parts of the report</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {spec.sections.map((s) => (
                  <label key={s.key} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={sections.includes(s.key)} onChange={(e) => setSections((l) => toggle(l, s.key, e.target.checked))} className="size-4 accent-forest-700" />
                    {s.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {spec.extras?.length || spec.columns?.length ? (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold text-ink">Include</legend>
              <div className="grid gap-1 sm:grid-cols-3">
                {(spec.extras ?? []).map((e) => (
                  <label key={e.key} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={extras[e.key] ?? false} onChange={(ev) => setExtras((x) => ({ ...x, [e.key]: ev.target.checked }))} className="size-4 accent-forest-700" data-testid={`share-extra-${e.key}`} />
                    {e.label}
                  </label>
                ))}
                {(spec.columns ?? []).map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={columns.includes(c.key)} onChange={(ev) => setColumns((l) => columnOrder(toggle(l, c.key, ev.target.checked)))} className="size-4 accent-forest-700" data-testid={`share-column-${c.key}`} />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-semibold text-ink">Format</legend>
            <div className="flex flex-wrap gap-4">
              {(['PDF', 'LINK'] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="share-format" checked={format === f} onChange={() => setFormat(f)} className="size-4 accent-forest-700" data-testid={`share-format-${f.toLowerCase()}`} />
                  {f === 'PDF' ? 'PDF' : 'Secure link'}
                </label>
              ))}
            </div>
            {format === 'PDF' && !fileShare ? (
              <p className="text-[11px] text-ink-muted">
                This browser cannot attach a file to WhatsApp, so a secure link to the same report is sent instead. Use Download PDF to attach the
                file yourself.
              </p>
            ) : null}
          </fieldset>

          {usesLink ? (
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Link expires after
              <Select value={expiry} onChange={(e) => setExpiry(e.target.value as ShareExpiry)} className="h-9 w-48" aria-label="Link expires after" data-testid="share-expiry">
                {SHARE_EXPIRY.filter((e) => e !== 'never' || env.canNeverExpire).map((e) => (
                  <option key={e} value={e}>
                    {SHARE_EXPIRY_LABEL[e]}
                  </option>
                ))}
              </Select>
              <span className="text-[11px]">Read-only, this report only — no sign-in and nothing else in the ERP. It can be revoked at any time.</span>
            </label>
          ) : null}

          <p className="text-xs text-ink-muted" data-testid="share-summary">
            {snapshot ? `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'} · ${snapshot.scope}` : 'Reading the report…'}
          </p>

          {nothing ? <Callout tone="warning">There is nothing in this selection to share.</Callout> : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}

          {link ? (
            <div className="space-y-2 rounded-lg border border-forest-200 bg-forest-50/60 px-3 py-2 text-xs" data-testid="share-link-ready">
              <p className="font-semibold text-ink">Secure link ready{link.expiresAt ? ` · expires ${new Date(link.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}</p>
              <p className="break-all font-mono text-[11px] text-ink-muted" data-testid="share-link-url">{link.url}</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={link.whatsapp} target="_blank" rel="noopener noreferrer" data-testid="share-open-whatsapp" onClick={() => log(link.meta, ['SHARE_WHATSAPP_OPENED'])}>
                    <ExternalLink /> Open WhatsApp
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast.success('Link copied.'), () => toast.error('Could not copy.'))}
                >
                  <Copy /> Copy link
                </Button>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={downloadPdf} disabled={!snapshot || nothing || busy} data-testid="share-download-pdf">
              <Download /> Download PDF
            </Button>
            <Button
              onClick={usesLink ? shareLink : shareFile}
              disabled={!snapshot || nothing || busy || (!usesLink && !pdfReady)}
              loading={busy}
              className="bg-[#128C7E] hover:bg-[#0f7a6e]"
              data-testid="share-submit"
            >
              <WhatsAppIcon className="fill-white" /> Share on WhatsApp
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
