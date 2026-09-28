'use client';

import * as React from 'react';
import { ShareDialog, ShareTrigger, type ShareSpec } from '@/components/share/share-dialog';
import { readFacts, readTables } from '@/lib/share/dom';
import { shareReportLabel, type ShareReportKey } from '@/lib/share/model';
import { formatDate } from '@/lib/format';

/** The period the page is showing: what it prints in its heading, or the dates in its address. */
function pagePeriod(root: Element): string | undefined {
  const marked = root.querySelector('[data-share-period]')?.textContent?.replace(/\s+/g, ' ').trim();
  if (marked) return marked;
  const params = new URLSearchParams(window.location.search);
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(new Date(`${v}T00:00:00.000Z`)) : null);
  const from = day(params.get('from'));
  const to = day(params.get('to'));
  const asOf = day(params.get('asOf') ?? params.get('asof') ?? params.get('date'));
  if (from || to) return `${from ?? 'the start'} – ${to ?? 'today'}`;
  return asOf ? `As of ${asOf}` : undefined;
}

/**
 * WhatsApp sharing for a report page that draws its own tables — Profit &
 * Loss, Balance Sheet, shipment costing, stock valuation and the rest.
 *
 * When pressed it reads the report off the page as it stands — the period,
 * filters, expanded sections and columns on screen — so what is shared is
 * exactly what is shown. Pages built on the ledger or list components share
 * through those instead, where every filtered row is at hand, not only the
 * page on screen.
 */
export function ReportShareButton({
  report,
  title,
  subject,
  period,
  filters = [],
  root = '#main-content',
  label,
}: {
  report: ShareReportKey;
  title?: string;
  subject?: string;
  period?: string;
  filters?: string[];
  /** Where the report is on the page; the whole page by default. */
  root?: string;
  label?: string;
}) {
  const [spec, setSpec] = React.useState<{ id: number; spec: ShareSpec } | null>(null);

  function open() {
    const el = document.querySelector(root) ?? document.body;
    const tables = readTables(el);
    const facts = readFacts(el);
    const shareSpec: ShareSpec = {
      report,
      title: title ?? shareReportLabel(report),
      subject,
      period: period ?? pagePeriod(el),
      scopes: [{ key: 'view', label: 'Current report, as on screen', hint: 'The dates, filters and columns you have chosen.' }],
      defaultScope: 'view',
      sections: tables.map((t, i) => ({ key: t.key, label: t.heading ?? `Table ${i + 1}` })),
      extras: facts.length ? [{ key: 'facts', label: 'Summary figures', checked: true }] : [],
      build: (choice) => ({
        filters,
        scopeLabel: 'Current report',
        facts: choice.extras.facts === false ? [] : facts,
        sections: tables.filter((t) => choice.sections.includes(t.key)).map((t) => t.section),
      }),
    };
    setSpec((s) => ({ id: (s?.id ?? 0) + 1, spec: shareSpec }));
  }

  return (
    <>
      <ShareTrigger onClick={open} label={label} />
      {spec ? <ShareDialog key={spec.id} open onOpenChange={(o) => !o && setSpec(null)} spec={spec.spec} /> : null}
    </>
  );
}
